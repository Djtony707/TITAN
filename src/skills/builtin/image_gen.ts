/**
 * TITAN — Image Generation Skill (Built-in)
 * Generate and edit images using OpenAI DALL-E 3 API.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';
import { loadConfig } from '../../config/config.js';

const COMPONENT = 'ImageGen';

export function registerImageGenSkill(): void {
    // Tool 1: generate_image
    registerSkill(
        { name: 'image_gen', description: 'Generate images from text prompts using DALL-E 3. USE THIS WHEN Tony says: "generate an image of X", "create a picture of X", "draw X", "make art of X", "make an image that looks like X". RULES: Requires OpenAI API key. Use descriptive prompts for best results.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'generate_image',
            description: 'Generates a high-quality image from a detailed text prompt using OpenAI DALL-E 3. USE THIS WHEN Tony says: "generate an image of X", "create a picture of X", "draw X", "make art of X", "visualize X", "make an image that looks like X". WORKFLOW: Craft a detailed descriptive prompt, call generate_image, return the image URL. RULES: Requires OpenAI API key. More detail in the prompt = better results.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Detailed text prompt describing the image to generate (e.g., "A serene mountain landscape at sunset with golden light")',
                    },
                    size: {
                        type: 'string',
                        enum: ['1024x1024', '1792x1024', '1024x1792'],
                        description: 'Image dimensions. Default: 1024x1024',
                    },
                    quality: {
                        type: 'string',
                        enum: ['standard', 'hd'],
                        description: 'Image quality. "standard" is faster, "hd" is higher quality. Default: standard',
                    },
                    style: {
                        type: 'string',
                        enum: ['vivid', 'natural'],
                        description: 'Image style. "vivid" for more detailed colors, "natural" for more realistic. Default: vivid',
                    },
                },
                required: ['prompt'],
            },
            execute: async (args: Record<string, unknown>) => {
                const prompt = args.prompt as string;
                const size = (args.size as string) || '1024x1024';
                const quality = (args.quality as string) || 'standard';
                const style = (args.style as string) || 'vivid';

                if (!prompt || prompt.trim().length === 0) {
                    return 'Error: prompt is required and cannot be empty';
                }

                try {
                    logger.info(COMPONENT, `Generating image with prompt: ${prompt.substring(0, 80)}...`);

                    const config = loadConfig();
                    const apiKey = config.providers.openai?.apiKey || process.env.OPENAI_API_KEY;

                    if (!apiKey) {
                        return 'Error: OpenAI API key not configured. Set OPENAI_API_KEY or configure providers.openai.apiKey in titan.json';
                    }

                    const response = await fetch('https://api.openai.com/v1/images/generations', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                            model: 'dall-e-3',
                            prompt,
                            size,
                            quality,
                            style,
                            n: 1,
                        }),
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.error(COMPONENT, `OpenAI API error: ${response.status} ${errorText}`);
                        return `Error: OpenAI API error (${response.status}): ${errorText}`;
                    }

                    const data = (await response.json()) as { data?: Array<{ url: string; revised_prompt: string }> };

                    if (!data.data || data.data.length === 0) {
                        return 'Error: No image data returned from OpenAI API';
                    }

                    const imageUrl = data.data[0].url;
                    const revisedPrompt = data.data[0].revised_prompt;

                    logger.info(COMPONENT, `Image generated successfully: ${imageUrl}`);

                    return `Image generated successfully!
URL: ${imageUrl}

Size: ${size}
Quality: ${quality}
Style: ${style}

Revised Prompt (DALL-E interpretation): ${revisedPrompt}`;
                } catch (error) {
                    const msg = (error as Error).message;
                    logger.error(COMPONENT, `Image generation failed: ${msg}`);
                    return `Error generating image: ${msg}`;
                }
            },
        },
    );

    // Tool 2: edit_image
    registerSkill(
        { name: 'image_edit', description: 'Edit or modify an existing image. USE THIS WHEN Tony says: "edit this image", "modify this picture", "change X in this image". NOTE: Full editing requires a PNG with transparency. For most cases, generate_image is simpler.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'edit_image',
            description: 'Provides guidance on editing an existing image using DALL-E 2. USE THIS WHEN Tony says: "edit this image", "modify this picture", "change X in this image". NOTE: Full image editing requires a PNG file with an alpha channel transparency mask. For most cases, use generate_image instead — it\'s simpler and more reliable.',
            parameters: {
                type: 'object',
                properties: {
                    imagePath: {
                        type: 'string',
                        description: 'Path to the image file to edit (PNG format with transparency)',
                    },
                    prompt: {
                        type: 'string',
                        description: 'Description of what to change in the image',
                    },
                },
                required: ['imagePath', 'prompt'],
            },
            execute: async (args: Record<string, unknown>) => {
                const imagePath = args.imagePath as string;
                const prompt = args.prompt as string;

                if (!imagePath || !prompt) {
                    return 'Error: imagePath and prompt are required';
                }

                return `Image editing information:

To edit images with DALL-E 2:
1. Prepare a PNG image file with transparency (alpha channel)
2. Use the image as the base for editing
3. Provide a text prompt describing the desired changes
4. DALL-E 2 will generate variations based on the provided mask and prompt

The generate_image tool is more straightforward for most use cases, as it creates images from scratch without requiring masks.

For advanced image editing workflows, you can:
- Use existing image editing tools to create masks
- Prepare base images with transparency where needed
- Use tools like Python with PIL/cv2 to programmatically create and modify images

Image path: ${imagePath}
Edit prompt: ${prompt}

For full implementation, consider using dedicated image editing software or Python-based tools.`;
            },
        },
    );
}
