/**
 * TITAN — Runway Video Provider
 * Generates video via Runway Gen-4 API.
 * Requires RUNWAY_API_KEY environment variable.
 */
import type { VideoProvider, VideoGenerationRequest, VideoGenerationResult } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'RunwayVideo';
const API_BASE = 'https://api.dev.runwayml.com/v1';

export class RunwayVideoProvider implements VideoProvider {
    name = 'runway';
    models = ['gen4', 'gen3a_turbo'];
    private apiKey: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.RUNWAY_API_KEY || '';
    }

    async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
        if (!this.apiKey) {
            return { id: '', status: 'failed', error: 'RUNWAY_API_KEY not configured', provider: this.name, model: request.model || 'gen4' };
        }

        const model = request.model || 'gen4';
        logger.info(COMPONENT, `Generating video: "${request.prompt.slice(0, 80)}" (model=${model})`);

        try {
            const resp = await fetch(`${API_BASE}/image_to_video`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'X-Runway-Version': '2024-11-06',
                },
                body: JSON.stringify({
                    model,
                    promptText: request.prompt,
                    duration: request.duration || 5,
                    ratio: request.aspectRatio || '16:9',
                }),
            });

            if (!resp.ok) {
                const error = await resp.text();
                return { id: '', status: 'failed', error: `Runway API error: ${resp.status} ${error.slice(0, 200)}`, provider: this.name, model };
            }

            const data = await resp.json() as { id: string };
            return { id: data.id, status: 'processing', provider: this.name, model };
        } catch (err) {
            return { id: '', status: 'failed', error: (err as Error).message, provider: this.name, model };
        }
    }

    async checkStatus(jobId: string): Promise<VideoGenerationResult> {
        if (!this.apiKey) {
            return { id: jobId, status: 'failed', error: 'RUNWAY_API_KEY not configured', provider: this.name, model: 'gen4' };
        }

        try {
            const resp = await fetch(`${API_BASE}/tasks/${jobId}`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'X-Runway-Version': '2024-11-06' },
            });

            if (!resp.ok) {
                return { id: jobId, status: 'failed', error: `Status check failed: ${resp.status}`, provider: this.name, model: 'gen4' };
            }

            const data = await resp.json() as { status: string; output?: string[]; failure?: string };

            const statusMap: Record<string, VideoGenerationResult['status']> = {
                'PENDING': 'pending',
                'RUNNING': 'processing',
                'SUCCEEDED': 'completed',
                'FAILED': 'failed',
            };

            return {
                id: jobId,
                status: statusMap[data.status] || 'processing',
                videoUrl: data.output?.[0],
                error: data.failure,
                provider: this.name,
                model: 'gen4',
            };
        } catch (err) {
            return { id: jobId, status: 'failed', error: (err as Error).message, provider: this.name, model: 'gen4' };
        }
    }
}
