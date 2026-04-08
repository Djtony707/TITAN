/**
 * TITAN — Video Provider Base
 * Abstract interface for video generation providers (xAI, Runway, Alibaba Wan).
 */

export interface VideoGenerationRequest {
    prompt: string;
    model?: string;
    duration?: number;       // seconds
    resolution?: string;     // e.g., '1080p', '720p'
    aspectRatio?: string;    // e.g., '16:9', '9:16'
    style?: string;
}

export interface VideoGenerationResult {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    videoUrl?: string;
    thumbnailUrl?: string;
    durationMs?: number;
    error?: string;
    provider: string;
    model: string;
}

export interface VideoProvider {
    name: string;
    models: string[];
    generate(request: VideoGenerationRequest): Promise<VideoGenerationResult>;
    checkStatus(jobId: string): Promise<VideoGenerationResult>;
}
