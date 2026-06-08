/**
 * TITAN — OpenAI API Compatibility Layer
 * Serves /v1/models, /v1/chat/completions, /v1/embeddings so any OpenAI-compatible
 * client (OpenWebUI, Continue.dev, LiteLLM, etc.) can connect to TITAN as a provider.
 */
import { Router, type Request, type Response } from 'express';
import { chat, chatStream, tryResolveModel, discoverAllModels, getKnownProviderNames } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger.js';
import { setupSSEFlush } from '../utils/sseFlush.js';

const COMPONENT = 'OpenAI-Compat';

export function createOpenAICompatRouter(): Router {
    const router = Router();

    // GET /v1/models — list available models
    router.get('/models', (_req: Request, res: Response) => {
        const config = loadConfig();
        const currentModel = config.agent.model || 'unknown';
        const aliases = config.agent.modelAliases || {};

        const models = [
            { id: currentModel, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'titan' },
            ...Object.entries(aliases)
                .filter(([, v]) => v && v !== currentModel)
                .map(([_key, value]) => ({
                    id: value as string,
                    object: 'model' as const,
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'titan',
                })),
        ];

        res.json({ object: 'list', data: models });
    });

    // POST /v1/chat/completions — chat completion (streaming and non-streaming)
    router.post('/chat/completions', async (req: Request, res: Response) => {
        const { model, messages, stream, temperature, max_tokens } = req.body;

        if (!messages || !Array.isArray(messages)) {
            res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
            return;
        }

        const config = loadConfig();
        const effectiveModel = model || config.agent.model;
        const chatId = `chatcmpl-${uuid().slice(0, 12)}`;

        // ── v6.5 P2: validate model is recognized BEFORE generating ──
        // Sage flagged this during the v6.5 Council session: silent fallback to
        // config.agent.model when the client sends a model TITAN doesn't know
        // (e.g. 'claude-3.7-sonnet') is a trust violation — the client thinks
        // they got 3.7-sonnet's output. Return 404 with the recognized models
        // list instead. Skip this check when the client omitted `model`
        // entirely (using TITAN's default is fine).
        if (model) {
            // v6.5 fix — the old guard used tryResolveModel(), which RESOLVES a
            // bare id like 'gpt-4'/'claude-3.7-sonnet' to anthropic/<literal> and
            // returns truthy, so the 404 only fired for ids with an explicit
            // UNKNOWN provider prefix ('foo/bar'). The exact deception P2 targets
            // (bare 'claude-3.7-sonnet' → silent mis-route → Anthropic 500) slipped
            // through. Validate against the REAL servable-model set instead.
            const aliases = (config.agent.modelAliases || {}) as Record<string, string>;
            const aliased = aliases[effectiveModel] || effectiveModel;
            const bareName = aliased.includes('/') ? aliased.split('/').slice(1).join('/') : aliased;

            let known = false;
            let availableIds: string[] = [];
            try {
                const discovered = await discoverAllModels();
                availableIds = discovered.map(m => m.id).slice(0, 50);
                known =
                    // a real, servable model — matched by full id or bare model name
                    discovered.some(m => m.id === aliased || m.model === aliased || m.model === bareName)
                    // OR an explicit, KNOWN provider prefix — the client deliberately
                    // chose a provider, so let that provider validate the model name.
                    || (aliased.includes('/') && getKnownProviderNames().includes(aliased.split('/')[0]));
            } catch {
                // Discovery failed — we can't prove the model is unknown, so fall
                // back to the old resolve check rather than block a valid request.
                known = !!tryResolveModel(aliased);
            }

            if (!known) {
                res.status(404).json({
                    error: {
                        message: `Model '${model}' is not recognized by TITAN: no configured alias, not a servable model, and no known provider prefix. See 'available_models'.`,
                        type: 'model_not_found',
                        param: 'model',
                        code: 'model_not_found',
                        available_models: availableIds,
                    },
                });
                return;
            }
        }

        // ── v6.5 P0: cost transparency headers ──
        // Sage flagged the cost-deception bug: if client sends 'gpt-4' + OpenAI
        // key and TITAN routes to ollama/qwen, the client's OpenAI dashboard
        // never moves. Set x-titan-provider so the actual route is at least
        // VISIBLE in network logs even when the body says model='gpt-4'.
        const routeInfo = tryResolveModel(effectiveModel);
        const actualProvider = routeInfo?.provider?.name ?? 'unknown';
        const actualModelId = routeInfo ? `${routeInfo.provider.name}/${routeInfo.model}` : effectiveModel;

        logger.info(COMPONENT, `Chat completion: requested=${effectiveModel} → routed=${actualModelId}, messages=${messages.length}, stream=${!!stream}`);

        // v6.5 P1 — cancel upstream generation when the client disconnects.
        // Cline/Continue/Aider give up after 30-60s while a TITAN skill loop can
        // run for minutes; without this we keep burning provider tokens to a dead
        // socket. The signal flows chat/chatStream → router → provider fetch().
        const ac = new AbortController();
        req.on('close', () => ac.abort());

        try {
            if (stream) {
                // SSE streaming response
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                    // v6.5 P0: cost transparency — surface the actual route
                    // even when the body says model='gpt-4'. Clients can read
                    // this header in their network logs / SDK middleware.
                    'X-Titan-Provider': actualProvider,
                    'X-Titan-Routed-Model': actualModelId,
                    'X-Titan-Requested-Model': effectiveModel,
                });
                const sseWrite = setupSSEFlush(res);

                for await (const chunk of chatStream({
                    model: effectiveModel,
                    messages,
                    temperature: temperature ?? config.agent.temperature,
                    maxTokens: max_tokens ?? config.agent.maxTokens,
                    signal: ac.signal,
                })) {
                    if (chunk.type === 'text' && chunk.content) {
                        const data = {
                            id: chatId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: effectiveModel,
                            choices: [{
                                index: 0,
                                delta: { content: chunk.content },
                                finish_reason: null,
                            }],
                        };
                        sseWrite(`data: ${JSON.stringify(data)}\n\n`);
                    }
                }

                // Send final chunk
                sseWrite(`data: ${JSON.stringify({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: effectiveModel,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                })}\n\n`);
                sseWrite('data: [DONE]\n\n');
                res.end();
            } else {
                // Non-streaming response
                const response = await chat({
                    model: effectiveModel,
                    messages,
                    temperature: temperature ?? config.agent.temperature,
                    maxTokens: max_tokens ?? config.agent.maxTokens,
                    signal: ac.signal,
                });

                // v6.5 P0: cost transparency headers on the non-stream path too
                res.setHeader('X-Titan-Provider', actualProvider);
                res.setHeader('X-Titan-Routed-Model', actualModelId);
                res.setHeader('X-Titan-Requested-Model', effectiveModel);

                res.json({
                    id: chatId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: response.model || effectiveModel,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: response.content },
                        finish_reason: response.finishReason || 'stop',
                    }],
                    usage: {
                        prompt_tokens: response.usage?.promptTokens ?? 0,
                        completion_tokens: response.usage?.completionTokens ?? 0,
                        total_tokens: response.usage?.totalTokens ?? 0,
                    },
                });
            }
        } catch (err) {
            // v6.5 P1/P3 — distinguish client-cancellation from real failures, and
            // never throw ERR_HTTP_HEADERS_SENT on the streaming path. If the client
            // disconnected (ac aborted) or the stream timed out, that's expected
            // cancellation, not a server error — there's nothing to write to a dead
            // socket. Once SSE headers are sent we can't change the status code, so
            // just close the stream cleanly. X-Titan-Error-Class gives clients a
            // back-channel for the non-streaming case.
            const errMsg = (err as Error).message;
            const errName = (err as Error).name;
            const aborted = ac.signal.aborted || errName === 'AbortError' || errName === 'TimeoutError';
            if (aborted) {
                logger.info(COMPONENT, `Chat completion cancelled (client disconnect or timeout): ${errMsg}`);
            } else {
                logger.error(COMPONENT, `Chat completion error: ${errMsg}`);
            }
            if (res.headersSent) {
                // streaming path — terminate the SSE stream without a status change
                try { res.end(); } catch { /* socket already gone */ }
            } else {
                res.setHeader('X-Titan-Provider', actualProvider);
                res.setHeader('X-Titan-Error-Class', aborted ? 'request_cancelled' : 'server_error');
                res.status(aborted ? 499 : 500).json({
                    error: { message: errMsg, type: aborted ? 'request_cancelled' : 'server_error' },
                });
            }
        }
    });

    // POST /v1/embeddings — embedding generation (proxy to Ollama)
    router.post('/embeddings', async (req: Request, res: Response) => {
        const { model, input } = req.body;
        const config = loadConfig();
        const embeddingModel = model || (config.memory as Record<string, unknown>)?.embeddingModel || 'nomic-embed-text';

        try {
            // Proxy to Ollama embeddings endpoint
            const ollamaUrl = config.providers?.ollama?.baseUrl || 'http://localhost:11434';
            const texts = Array.isArray(input) ? input : [input];
            const embeddings = [];

            for (let i = 0; i < texts.length; i++) {
                const resp = await fetch(`${ollamaUrl}/api/embed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: embeddingModel, input: texts[i] }),
                });

                if (!resp.ok) throw new Error(`Ollama embed failed: ${resp.status}`);
                const data = await resp.json() as { embeddings?: number[][] };
                embeddings.push({
                    object: 'embedding',
                    index: i,
                    embedding: data.embeddings?.[0] || [],
                });
            }

            res.json({
                object: 'list',
                data: embeddings,
                model: embeddingModel,
                usage: { prompt_tokens: 0, total_tokens: 0 },
            });
        } catch (err) {
            res.status(500).json({
                error: { message: (err as Error).message, type: 'server_error' },
            });
        }
    });

    return router;
}
