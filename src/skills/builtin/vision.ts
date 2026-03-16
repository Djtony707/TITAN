/**
 * TITAN — Vision Tool
 * Allows the agent to "see" by sending local images to vision-capable models (Claude 3.5 Sonnet / GPT-4o).
 */
import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';
import { registerSkill } from '../registry.js';
import type { ToolHandler } from '../../agent/toolRunner.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'VisionTool';

const meta = {
    name: 'analyze_image',
    description: 'Analyzes an image file to answer questions or describe its contents. USE THIS WHEN Tony says: "what\'s in this image", "describe this screenshot", "read the text in this image", "analyze this photo", "what does this image show", "look at this file". WORKFLOW: Pass the absolute file path and a specific question or prompt about the image. RULES: Works on local file paths (png, jpg, webp, gif). Requires Anthropic or OpenAI API key configured.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

function getMediaType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        default: return 'image/jpeg';
    }
}

async function analyzeWithAnthropic(base64Data: string, mediaType: string, prompt: string, apiKey: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1024,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: base64Data,
                            }
                        },
                        {
                            type: 'text',
                            text: prompt
                        }
                    ]
                }
            ]
        })
    });

    if (!response.ok) {
        throw new Error(`Anthropic Vision API error: ${await response.text()}`);
    }

    const data = (await response.json()) as { content: Array<{ text: string }> };
    return data.content[0].text;
}

async function analyzeWithOpenAI(base64Data: string, mediaType: string, prompt: string, apiKey: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: 1024,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: prompt
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:${mediaType};base64,${base64Data}`
                            }
                        }
                    ]
                }
            ]
        })
    });

    if (!response.ok) {
        throw new Error(`OpenAI Vision API error: ${await response.text()}`);
    }

    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
}

const handler: ToolHandler = {
    name: 'analyze_image',
    description: 'Analyzes a local image file using a vision-capable model to answer questions or describe its contents. USE THIS WHEN Tony says: "what\'s in this image", "describe this screenshot", "read text in this image", "analyze this photo", "what does this picture show". WORKFLOW: Pass the absolute filePath and a prompt/question. RULES: Requires an absolute local file path. Supports png, jpg, webp, gif. Uses Anthropic Claude or OpenAI GPT-4o depending on configured API keys.',
    parameters: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'The absolute local path to the image file (png, jpg, webp, gif).',
            },
            prompt: {
                type: 'string',
                description: 'What you want to know about the image (e.g. "Describe this image in detail", "What text is in this image?", "Is there a cat here?").',
            },
        },
        required: ['filePath', 'prompt'],
    },
    execute: async (args: Record<string, unknown>) => {
        const filePath = args.filePath as string;
        const prompt = args.prompt as string;

        if (!filePath || !prompt) {
            return "Error: missing required arguments filePath or prompt.";
        }

        if (!existsSync(filePath)) {
            return `Error: File not found at ${filePath}`;
        }

        try {
            logger.info(COMPONENT, `Reading image ${filePath} for analysis...`);
            const fileBuffer = readFileSync(filePath);
            const base64Data = fileBuffer.toString('base64');
            const mediaType = getMediaType(filePath);

            const config = loadConfig();

            if (config.providers.anthropic && config.providers.anthropic.apiKey) {
                logger.debug(COMPONENT, 'Using Anthropic Claude 3.5 Sonnet for vision');
                return await analyzeWithAnthropic(base64Data, mediaType, prompt, config.providers.anthropic.apiKey);
            }
            else if (config.providers.openai && config.providers.openai.apiKey) {
                logger.debug(COMPONENT, 'Using OpenAI GPT-4o for vision');
                return await analyzeWithOpenAI(base64Data, mediaType, prompt, config.providers.openai.apiKey);
            }
            else {
                return "Error: Vision tool requires either an Anthropic or OpenAI API key configured in TITAN.";
            }
        } catch (e: unknown) {
            return `Vision Analysis Failed: ${(e as Error).message}`;
        }
    },
};

export function registerVisionSkill(): void {
    registerSkill(meta, handler);
}
