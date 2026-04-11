/**
 * TITAN — Mixture of Agents
 *
 * Fan out a query to multiple LLM providers in parallel, then synthesize the best answer.
 * Useful for complex reasoning, math, and cross-domain problems.
 * Inspired by Hermes mixture_of_agents_tool.py.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'MixtureOfAgents';

/** Pick N diverse models from configured providers */
function pickDiverseModels(count: number): string[] {
    const config = loadConfig();
    const candidates: string[] = [];

    // Check which providers have API keys configured
    const providers = config.providers as Record<string, { apiKey?: string }>;
    const providerModels: Record<string, string> = {
        anthropic: 'anthropic/claude-sonnet-4-20250514',
        openai: 'openai/gpt-4o',
        google: 'google/gemini-2.5-pro',
        groq: 'groq/llama-3.3-70b-versatile',
        deepseek: 'deepseek/deepseek-chat',
        mistral: 'mistral/mistral-large-latest',
        xai: 'xai/grok-3',
    };

    for (const [name, model] of Object.entries(providerModels)) {
        if (providers[name]?.apiKey) {
            candidates.push(model);
        }
    }

    // Also check if ollama is available (no API key needed)
    if (providers.ollama) {
        candidates.push('ollama/llama3.3');
    }

    if (candidates.length === 0) {
        // Fallback: use the configured model
        candidates.push(config.agent.model);
    }

    // Shuffle and pick N
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

/** Synthesize multiple responses into one */
async function synthesize(
    query: string,
    responses: Array<{ model: string; content: string }>,
    aggregatorModel: string,
): Promise<string> {
    const responseSummary = responses.map((r, i) =>
        `--- Response ${i + 1} (${r.model}) ---\n${r.content}`,
    ).join('\n\n');

    const synthPrompt = `You are an expert synthesizer. Multiple AI models were asked the same question. Review their responses and produce the single best answer that combines the strongest reasoning from each.

## Original Question
${query}

## Model Responses
${responseSummary}

## Instructions
- Identify the strongest reasoning across all responses
- Resolve any contradictions by picking the most well-supported answer
- Produce a single, clear, comprehensive answer
- Do NOT mention that multiple models were consulted`;

    try {
        const result = await chat({
            model: aggregatorModel,
            messages: [{ role: 'user', content: synthPrompt }],
            temperature: 0.4,
        });
        return result.content;
    } catch (err) {
        logger.warn(COMPONENT, `Synthesis failed: ${(err as Error).message}`);
        // Fallback: return the longest response
        return responses.sort((a, b) => b.content.length - a.content.length)[0].content;
    }
}

/** Vote: pick the response most similar to others */
function vote(responses: Array<{ model: string; content: string }>): string {
    if (responses.length === 1) return responses[0].content;

    // Simple word overlap scoring
    const words = responses.map(r => new Set(r.content.toLowerCase().split(/\s+/)));
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < responses.length; i++) {
        let score = 0;
        for (let j = 0; j < responses.length; j++) {
            if (i === j) continue;
            // Count overlapping words
            for (const word of words[i]) {
                if (words[j].has(word)) score++;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    return responses[bestIdx].content;
}

export function registerMixtureOfAgentsSkill(): void {
    registerSkill(
        {
            name: 'mixture_of_agents',
            description: 'Query multiple AI models and synthesize the best answer',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'mixture_of_agents',
            description: 'Fan out a question to multiple AI models in parallel and synthesize the best answer.\nUSE THIS WHEN: user says "ask multiple models", "get different perspectives", "think hard about this", "consult multiple AIs", or the task requires diverse reasoning.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The question or problem to solve',
                    },
                    models: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Models to query (provider/model format). Default: picks 3 diverse models from configured providers.',
                    },
                    strategy: {
                        type: 'string',
                        enum: ['synthesize', 'vote', 'best'],
                        description: 'Aggregation strategy. synthesize=combine all (default), vote=majority consensus, best=pick highest quality.',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = args.query as string;
                const models = (args.models as string[] | undefined) || pickDiverseModels(3);
                const strategy = (args.strategy as string) || 'synthesize';

                if (models.length === 0) {
                    return 'No models available. Configure at least one provider API key.';
                }

                logger.info(COMPONENT, `Querying ${models.length} models: ${models.join(', ')} (strategy=${strategy})`);

                // Fan out to all models in parallel
                const results = await Promise.allSettled(
                    models.map(async (model) => {
                        const start = Date.now();
                        try {
                            const response = await chat({
                                model,
                                messages: [{ role: 'user', content: query }],
                                temperature: 0.6,
                            });
                            const elapsed = Date.now() - start;
                            logger.debug(COMPONENT, `${model}: ${response.content.length} chars in ${elapsed}ms`);
                            return { model, content: response.content };
                        } catch (err) {
                            logger.warn(COMPONENT, `${model} failed: ${(err as Error).message}`);
                            throw err;
                        }
                    }),
                );

                // Collect successful responses
                const responses = results
                    .filter((r): r is PromiseFulfilledResult<{ model: string; content: string }> => r.status === 'fulfilled')
                    .map(r => r.value);

                const failed = results.filter(r => r.status === 'rejected').length;

                if (responses.length === 0) {
                    return `All ${models.length} models failed. Check provider API keys and connectivity.`;
                }

                logger.info(COMPONENT, `${responses.length}/${models.length} models responded (${failed} failed)`);

                // Aggregate based on strategy
                let finalAnswer: string;
                const config = loadConfig();
                const aggregatorModel = config.agent.model;

                switch (strategy) {
                    case 'vote':
                        finalAnswer = vote(responses);
                        break;
                    case 'best':
                        // Use aggregator to pick the best
                        finalAnswer = await synthesize(
                            `Pick the single best response and return it verbatim:\n\n${query}`,
                            responses,
                            aggregatorModel,
                        );
                        break;
                    case 'synthesize':
                    default:
                        if (responses.length === 1) {
                            finalAnswer = responses[0].content;
                        } else {
                            finalAnswer = await synthesize(query, responses, aggregatorModel);
                        }
                        break;
                }

                // Build attribution
                const attribution = responses.map(r =>
                    `- **${r.model}**: ${r.content.length} chars`,
                ).join('\n');

                return `${finalAnswer}\n\n---\n*Mixture of Agents — ${responses.length} models consulted (strategy: ${strategy})*\n${attribution}`;
            },
        },
    );
}
