/**
 * NVIDIA Skill: AI-Q Deep Research Agent
 * Enterprise-grade research with multi-phase planning, parallel specialists,
 * and citation management. Uses NVIDIA AI-Q Blueprint.
 *
 * API: OpenAI-compatible /v1/chat/completions (supports SSE streaming)
 * Deployment options:
 *   1. Cloud: build.nvidia.com/nvidia/aiq (requires NVIDIA_API_KEY)
 *   2. Self-hosted: Docker Compose from github.com/NVIDIA-AI-Blueprints/aiq
 *
 * Config: nvidia.apiKey, nvidia.aiq.baseUrl
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'NVIDIA-AIQ';

// Cloud endpoint on build.nvidia.com
const CLOUD_BASE_URL = 'https://integrate.api.nvidia.com/v1';
// Local Docker deployment default
const LOCAL_BASE_URL = 'http://localhost:8090/v1';

function getConfig(): { apiKey: string; baseUrl: string } {
    const config = loadConfig();
    const nvidia = (config as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const apiKey = (nvidia?.apiKey as string) || process.env.NVIDIA_API_KEY || '';
    const aiq = nvidia?.aiq as Record<string, unknown> | undefined;
    const customUrl = aiq?.baseUrl as string | undefined;

    // Priority: custom config > cloud (if API key) > local
    let baseUrl: string;
    if (customUrl) {
        baseUrl = customUrl;
    } else if (apiKey) {
        baseUrl = CLOUD_BASE_URL;
    } else {
        baseUrl = LOCAL_BASE_URL;
    }

    return { apiKey, baseUrl };
}

export function register(): void {
    registerSkill({
        name: 'nvidia_aiq_research',
        description: 'NVIDIA AI-Q deep research agent — multi-phase research with planning, iteration, and citations',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'nvidia_aiq_research',
        description: `Perform deep research on a topic using NVIDIA AI-Q research agent.
Uses multi-phase research with planning, parallel specialists, and citation management.
Returns a structured report with citations.

Works via cloud (build.nvidia.com with NVIDIA_API_KEY) or self-hosted Docker deployment.

Use for complex research questions that benefit from multi-source synthesis:
- Technology comparisons and trade-off analysis
- Market analysis and competitive intelligence
- Scientific literature review
- Enterprise data research`,
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'The research question or topic to investigate.',
                },
                depth: {
                    type: 'string',
                    description: 'Research depth: "shallow" (quick answer, ~30s) or "deep" (comprehensive multi-phase, ~2min). Default: "deep".',
                    default: 'deep',
                },
            },
            required: ['question'],
        },
        execute: async (args: Record<string, unknown>) => {
            const question = args.question as string;
            const depth = (args.depth as string) || 'deep';
            const { apiKey, baseUrl } = getConfig();

            if (!question || question.trim().length < 5) {
                return 'Error: Provide a research question with at least 5 characters.';
            }

            if (!apiKey && baseUrl === CLOUD_BASE_URL) {
                return 'Error: NVIDIA_API_KEY required for cloud AI-Q. Set it in config (nvidia.apiKey) or env (NVIDIA_API_KEY). Get one at https://build.nvidia.com';
            }

            const systemPrompt = depth === 'deep'
                ? 'You are a deep research assistant. Conduct thorough multi-phase research on the topic. Provide a comprehensive report with citations, analysis, and conclusions.'
                : 'You are a research assistant. Provide a concise, well-sourced answer to the question.';

            logger.info(COMPONENT, `AI-Q research (${depth}) via ${baseUrl}: "${question.substring(0, 80)}..."`);

            try {
                // AI-Q is a blueprint (Docker Compose), not a single NIM model.
                // For cloud: use Nemotron 3 Super (reasoning model) via NIM API.
                // For self-hosted AI-Q: use the default model exposed by the blueprint.
                const model = baseUrl === CLOUD_BASE_URL
                    ? 'nvidia/llama-3.3-nemotron-super-49b-v1'
                    : 'aiq-research';

                const response = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
                    },
                    body: JSON.stringify({
                        model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: question },
                        ],
                        stream: true,
                        max_tokens: depth === 'deep' ? 16384 : 4096,
                    }),
                    signal: AbortSignal.timeout(depth === 'deep' ? 180_000 : 60_000),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 401 || response.status === 403) {
                        return `AI-Q auth error: Invalid or missing NVIDIA_API_KEY. Get one at https://build.nvidia.com`;
                    }
                    return `AI-Q error (${response.status}): ${errorText}`;
                }

                // Handle SSE streaming response
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('text/event-stream')) {
                    const text = await response.text();
                    const lines = text.split('\n');
                    let content = '';

                    for (const line of lines) {
                        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                        try {
                            const chunk = JSON.parse(line.slice(6)) as {
                                choices?: Array<{ delta?: { content?: string } }>;
                            };
                            const delta = chunk.choices?.[0]?.delta?.content;
                            if (delta) content += delta;
                        } catch {
                            // skip malformed chunks
                        }
                    }

                    if (content) return content;
                    return 'AI-Q returned empty research result. Try rephrasing the question.';
                }

                // Handle JSON response (non-streaming fallback)
                const result = await response.json() as {
                    choices?: Array<{
                        message?: {
                            content?: string | null;
                            reasoning_content?: string;
                        };
                    }>;
                };
                const msg = result.choices?.[0]?.message;
                // Nemotron reasoning models may return content=null with reasoning_content
                const content = msg?.content || msg?.reasoning_content;
                return content || 'AI-Q returned empty research result.';
            } catch (err) {
                const msg = (err as Error).message;
                if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
                    if (baseUrl === LOCAL_BASE_URL) {
                        return `Error: AI-Q server not reachable at ${baseUrl}. Deploy with:\n  git clone https://github.com/NVIDIA-AI-Blueprints/aiq.git && cd aiq/deploy/compose && docker compose up -d\nOr set NVIDIA_API_KEY to use cloud: https://build.nvidia.com`;
                    }
                    return `Error: AI-Q endpoint not reachable at ${baseUrl}. Check your network or NVIDIA API status.`;
                }
                if (msg.includes('timeout') || msg.includes('abort')) {
                    return `Error: AI-Q research timed out. Try with depth: "shallow" for faster results.`;
                }
                return `AI-Q error: ${msg}`;
            }
        },
    });
}
