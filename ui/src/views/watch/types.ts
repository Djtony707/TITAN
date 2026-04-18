/**
 * TITAN — Watch View types (v4.5.0)
 *
 * Shared types for the /watch page. Mirror src/watch/humanize.ts on the
 * backend — keep them in sync when adding event kinds.
 */

export type WatchKind =
    | 'drive'
    | 'tool'
    | 'goal'
    | 'channel'
    | 'agent'
    | 'soma'
    | 'system'
    | 'memory'
    | 'health';

export type WatchVoice = 'titan' | 'control';

export interface WatchEvent {
    id: string;
    timestamp: number;
    topic: string;
    kind: WatchKind;
    icon: string;
    captionTitan: string;
    captionControl: string;
    detail?: string;
    raw?: Record<string, unknown>;
}

export interface WatchDrive {
    id: string;
    label: string;
    satisfaction: number;
    setpoint: number;
    pressure: number;
    weight?: number;
    description?: string;
}

export interface WatchSnapshot {
    drives: WatchDrive[];
    totalPressure: number;
    dominantDrives: string[];
    activeGoals?: Array<{
        id: string;
        title: string;
        progress: number;
        createdAt: string;
    }>;
    timestamp: number;
}

/** Color palette per drive — matches CSS vars in WatchView.css */
export const DRIVE_COLORS: Record<string, string> = {
    purpose: '#a78bfa',   // violet
    hunger: '#fbbf24',    // amber
    curiosity: '#22d3ee', // cyan
    safety: '#34d399',    // emerald
    social: '#f472b6',    // pink
};

export const DRIVE_LABELS: Record<string, string> = {
    purpose: 'Purpose',
    hunger: 'Hunger',
    curiosity: 'Curiosity',
    safety: 'Safety',
    social: 'Social',
};

export function driveColor(id: string): string {
    return DRIVE_COLORS[id?.toLowerCase()] || '#a1a1aa';
}

export function driveLabel(id: string): string {
    return DRIVE_LABELS[id?.toLowerCase()] || id;
}

/** Topics that deserve promotion to the Focus card */
export const FOCUS_TOPICS = new Set([
    'soma:proposal',
    'turn:pre',
    'tool:call',
    'goal:subtask:ready',
    'initiative:start',
    'initiative:complete',
    'pressure:threshold',
    'goal:completed',
]);

/** Format a short relative time ("just now", "12s ago", "4m ago") */
export function timeAgo(ts: number, now: number = Date.now()): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
