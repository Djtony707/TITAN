/**
 * TITAN — Screen Recording Skill
 * Records agent browser sessions for QA review.
 * Uses ffmpeg for video capture when available.
 */
import { registerSkill } from '../registry.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import logger from '../../utils/logger.js';

const COMPONENT = 'ScreenRecord';

function hasFfmpeg(): boolean {
    try { execSync('which ffmpeg', { stdio: 'pipe' }); return true; } catch { return false; }
}

export function registerScreenRecordSkill(): void {
    registerSkill(
        { name: 'screen_record', description: 'Record screen for QA', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'screen_record',
            description: 'Start/stop screen recording for QA review. Records the display using ffmpeg.\nUSE THIS WHEN: "record my screen", "start recording", "capture a demo", "QA recording"\nRequires ffmpeg and X11/Wayland display.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start, stop, or check status' },
                    outputPath: { type: 'string', description: 'Output file path (default: /tmp/titan-recording.mp4)' },
                    duration: { type: 'number', description: 'Max duration in seconds (default: 300)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;

                if (!hasFfmpeg()) return 'Error: ffmpeg not installed. Install with: sudo apt install ffmpeg';

                if (action === 'start') {
                    const output = (args.outputPath as string) || '/tmp/titan-recording.mp4';
                    const duration = (args.duration as number) || 300;
                    const display = process.env.DISPLAY || ':0';
                    try {
                        execSync(`nohup ffmpeg -y -f x11grab -video_size 1920x1080 -framerate 15 -i ${display} -t ${duration} -c:v libx264 -preset ultrafast ${output} > /dev/null 2>&1 &`, { stdio: 'pipe' });
                        return `Recording started: ${output} (max ${duration}s). Use screen_record stop to finish.`;
                    } catch (e) {
                        return `Failed to start recording: ${(e as Error).message}. Make sure DISPLAY is set and X11 is running.`;
                    }
                }
                if (action === 'stop') {
                    try {
                        execSync('pkill -f "ffmpeg.*x11grab" || true', { stdio: 'pipe' });
                        return 'Recording stopped.';
                    } catch { return 'No active recording found.'; }
                }
                if (action === 'status') {
                    try {
                        const out = execSync('pgrep -f "ffmpeg.*x11grab" || echo none', { stdio: 'pipe' }).toString().trim();
                        return out === 'none' ? 'No active recording.' : `Recording active (PID: ${out})`;
                    } catch { return 'No active recording.'; }
                }
                return 'Unknown action. Use: start, stop, status';
            },
        },
    );
}
