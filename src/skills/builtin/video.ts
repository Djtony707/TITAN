/**
 * TITAN — Video Generation Skill
 * Tools: video_generate, video_status
 */
import { registerSkill } from '../registry.js';
import type { VideoProvider, VideoGenerationResult } from '../../providers/video/base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'VideoSkill';

// Provider registry
const providers = new Map<string, VideoProvider>();
const pendingJobs = new Map<string, { provider: string; createdAt: number }>();

async function initProviders(): Promise<void> {
    // Runway
    if (process.env.RUNWAY_API_KEY) {
        try {
            const { RunwayVideoProvider } = await import('../../providers/video/runway.js');
            providers.set('runway', new RunwayVideoProvider());
            logger.info(COMPONENT, 'Runway video provider loaded');
        } catch { /* unavailable */ }
    }
}

function getProvider(name?: string): VideoProvider | null {
    if (name && providers.has(name)) return providers.get(name)!;
    // Return first available
    const first = providers.values().next();
    return first.done ? null : first.value;
}

export function registerVideoSkill(): void {
    // Lazy init providers
    initProviders().catch(() => {});

    registerSkill(
        { name: 'video_generate', description: 'Generate video from text prompt', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'video_generate',
            description: 'Generate a video from a text prompt using AI video generation (Runway Gen-4, etc.).\n\nUSE THIS WHEN Tony says: "generate a video", "create a video of", "make a video showing".\n\nReturns a job ID — use video_status to check progress and get the download URL.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Text description of the video to generate' },
                    provider: { type: 'string', description: 'Video provider: "runway" (default)' },
                    duration: { type: 'number', description: 'Video duration in seconds (default: 5)' },
                    aspectRatio: { type: 'string', description: 'Aspect ratio: "16:9" (default), "9:16", "1:1"' },
                },
                required: ['prompt'],
            },
            execute: async (args) => {
                const provider = getProvider(args.provider as string);
                if (!provider) {
                    return 'Error: No video providers configured. Set RUNWAY_API_KEY to enable Runway video generation.';
                }

                const result = await provider.generate({
                    prompt: args.prompt as string,
                    duration: args.duration as number,
                    aspectRatio: args.aspectRatio as string,
                });

                if (result.status === 'failed') {
                    return `Error: ${result.error}`;
                }

                pendingJobs.set(result.id, { provider: provider.name, createdAt: Date.now() });
                return `Video generation started. Job ID: ${result.id}\nStatus: ${result.status}\nUse video_status with this ID to check progress.`;
            },
        },
    );

    registerSkill(
        { name: 'video_status', description: 'Check video generation status', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'video_status',
            description: 'Check the status of a video generation job and get the download URL when complete.',
            parameters: {
                type: 'object',
                properties: {
                    jobId: { type: 'string', description: 'The job ID from video_generate' },
                },
                required: ['jobId'],
            },
            execute: async (args) => {
                const jobId = args.jobId as string;
                const job = pendingJobs.get(jobId);
                if (!job) return `Error: Unknown job ID "${jobId}"`;

                const provider = getProvider(job.provider);
                if (!provider) return 'Error: Video provider no longer available';

                const result = await provider.checkStatus(jobId);

                if (result.status === 'completed' && result.videoUrl) {
                    pendingJobs.delete(jobId);
                    return `Video ready!\nURL: ${result.videoUrl}${result.thumbnailUrl ? `\nThumbnail: ${result.thumbnailUrl}` : ''}`;
                }

                if (result.status === 'failed') {
                    pendingJobs.delete(jobId);
                    return `Video generation failed: ${result.error}`;
                }

                const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
                return `Status: ${result.status} (${elapsed}s elapsed). Check again in a moment.`;
            },
        },
    );
}
