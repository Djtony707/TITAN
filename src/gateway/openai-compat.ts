/**
 * TITAN — OpenAI API Compatibility Layer
 * Serves /v1/models, /v1/chat/completions, /v1/embeddings so any OpenAI-compatible
 * client (OpenWebUI, Continue.dev, LiteLLM, etc.) can connect to TITAN as a provider.
 */
import { Router, type Request, type Response } from 'express';
import { chat, chatStream } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import { TITAN_VERSION } from '../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../utils/logger.js';

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
                .map(([key, value]) => ({
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
        const { model, messages, stream, temperature, max_tokens, top_p, stop } = req.body;

        if (!messages || !Array.isArray(messages)) {
            res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
            return;
        }

        const config = loadConfig();
        const effectiveModel = model || config.agent.model;
        const chatId = `chatcmpl-${uuid().slice(0, 12)}`;

        logger.info(COMPONENT, `Chat completion: model=${effectiveModel}, messages=${messages.length}, stream=${!!stream}`);

        try {
            if (stream) {
                // SSE streaming response
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                });

                for await (const chunk of chatStream({
                    model: effectiveModel,
                    messages,
                    temperature: temperature ?? config.agent.temperature,
                    maxTokens: max_tokens ?? config.agent.maxTokens,
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
                        res.write(`data: ${JSON.stringify(data)}\n\n`);
                    }
                }

                // Send final chunk
                res.write(`data: ${JSON.stringify({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: effectiveModel,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                // Non-streaming response
                const response = await chat({
                    model: effectiveModel,
                    messages,
                    temperature: temperature ?? config.agent.temperature,
                    maxTokens: max_tokens ?? config.agent.maxTokens,
                });

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
            logger.error(COMPONENT, `Chat completion error: ${(err as Error).message}`);
            res.status(500).json({
                error: { message: (err as Error).message, type: 'server_error' },
            });
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
