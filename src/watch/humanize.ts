/**
 * TITAN — Watch Humanizer (v4.5.0+)
 *
 * Translates technical events (drive:tick, tool:call, soma:proposal, etc.)
 * into short plain-English narration suitable for the /watch Pane.
 *
 * Two voices:
 *   - 'titan' (default, first-person) — "I'm curious about something new."
 *   - 'control' (mission-control, neutral) — "Curiosity pressure rising."
 *
 * Each event maps to a deterministic template. Novel events get a generic
 * fallback. Output is a 3-tuple:
 *   - caption: one-sentence human-readable text
 *   - kind: visual category (drive | tool | goal | channel | agent | soma | system)
 *   - icon: short emoji/icon hint for UI
 */

export type Voice = 'titan' | 'control';
export type Kind = 'drive' | 'tool' | 'goal' | 'channel' | 'agent' | 'soma' | 'system' | 'memory' | 'health';

export interface WatchEvent {
    /** Stable event ID for dedupe/tracking */
    id: string;
    /** Unix ms */
    timestamp: number;
    /** Original technical topic name */
    topic: string;
    /** Visual category */
    kind: Kind;
    /** Short emoji-ish icon */
    icon: string;
    /** Plain-English narration in first-person "TITAN" voice */
    captionTitan: string;
    /** Neutral mission-control narration */
    captionControl: string;
    /** Optional sub-caption / detail line */
    detail?: string;
    /** Raw payload for the debug panel / data-on-hover */
    raw?: Record<string, unknown>;
}

// ── Drive name prettifiers ─────────────────────────────────────────
const DRIVE_NAMES: Record<string, string> = {
    purpose: 'Purpose',
    hunger: 'Hunger',
    curiosity: 'Curiosity',
    safety: 'Safety',
    social: 'Social',
};

function driveLabel(id: string): string {
    return DRIVE_NAMES[id?.toLowerCase()] || (id?.[0]?.toUpperCase() + id?.slice(1)) || 'a drive';
}

// ── Tool name prettifiers ─────────────────────────────────────────
const TOOL_VERBS: Record<string, string> = {
    shell: 'running a shell command',
    read_file: 'reading a file',
    write_file: 'writing a file',
    edit_file: 'editing a file',
    web_search: 'searching the web',
    web_fetch: 'fetching a webpage',
    fb_post: 'posting to Facebook',
    fb_reply: 'replying on Facebook',
    fb_read_feed: 'reading the Facebook feed',
    fb_read_comments: 'checking Facebook comments',
    memory_store: 'saving something to memory',
    memory_recall: 'remembering something',
    memory_search: 'searching my memory',
    spawn_agent: 'asking another agent for help',
    code_exec: 'running some code',
    browser_navigate: 'opening a webpage',
    browser_act: 'interacting with a webpage',
    system_info: 'checking my systems',
    cron_create: 'scheduling a recurring task',
    send_email: 'drafting an email',
    read_email: 'checking email',
    image_gen: 'generating an image',
    voice_transcribe: 'transcribing audio',
    goals_list: 'checking my goals',
    goals_add: 'adding a goal',
    fb_autopilot: 'running Facebook autopilot',
    x_post: 'posting to X',
};

function toolVerb(tool: string): string {
    return TOOL_VERBS[tool] || `using ${tool.replace(/_/g, ' ')}`;
}

// ── Short string helpers ──────────────────────────────────────────
function clip(s: string | undefined, n = 60): string {
    if (!s) return '';
    const trimmed = s.trim().replace(/\s+/g, ' ');
    return trimmed.length > n ? trimmed.slice(0, n - 1).replace(/\s\S*$/, '') + '…' : trimmed;
}

// ── The big dictionary ────────────────────────────────────────────

type Humanizer = (payload: Record<string, unknown>) => {
    titan: string;
    control: string;
    kind: Kind;
    icon: string;
    detail?: string;
};

const H: Record<string, Humanizer> = {
    // ── Soma / Drives ────────────────────────────────────────────
    'drive:tick': (p) => {
        const drives = (p.drives as Array<Record<string, unknown>>) || [];
        const under = drives.filter(d => (d.pressure as number) > 0.01);
        if (under.length === 0) {
            return {
                titan: 'Feeling settled, all drives quiet.',
                control: 'All drives at setpoint.',
                kind: 'drive',
                icon: '🫁',
            };
        }
        const names = under.map(d => driveLabel(d.id as string)).join(' + ');
        return {
            titan: `${names} is asking for attention.`,
            control: `${names} below setpoint.`,
            kind: 'drive',
            icon: '🌡️',
            detail: under.map(d => `${driveLabel(d.id as string)} pressure ${(d.pressure as number).toFixed(2)}`).join(' · '),
        };
    },
    'hormone:update': (p) => {
        const dom = p.dominant as string | null;
        if (!dom) return { titan: 'Settled state.', control: 'Hormone baseline.', kind: 'drive', icon: '💧' };
        return {
            titan: `Mood shifting — ${driveLabel(dom).toLowerCase()} is rising.`,
            control: `Dominant hormone: ${driveLabel(dom)}.`,
            kind: 'drive',
            icon: '💧',
        };
    },
    'pressure:threshold': (p) => {
        const dominants = (p.dominantDrives as string[]) || [];
        const total = p.totalPressure as number;
        const names = dominants.map(driveLabel).join(', ');
        return {
            titan: `Pressure building — ${names} needs something.`,
            control: `Threshold crossed: totalPressure=${total.toFixed(2)}, dominant=${names}.`,
            kind: 'drive',
            icon: '⚡',
        };
    },
    'soma:proposal': (p) => {
        const title = clip(p.title as string, 80);
        const dominants = (p.dominantDrives as string[])?.map(driveLabel).join(', ') || 'a drive';
        return {
            titan: `Decided to try: "${title}"`,
            control: `Soma proposal filed (${dominants}): ${title}`,
            kind: 'soma',
            icon: '💡',
            detail: `From ${dominants}`,
        };
    },

    // ── Turns / agent loop ───────────────────────────────────────
    'turn:pre': (p) => {
        const msg = clip(p.message as string, 60);
        const channel = (p.channel as string) || 'cli';
        return {
            titan: `Heard from ${channel}: "${msg}"`,
            control: `Turn start (${channel}): ${msg}`,
            kind: 'channel',
            icon: channelIcon(channel),
        };
    },
    'turn:post': (p) => {
        const ms = p.durationMs as number;
        const tools = (p.toolsUsed as string[]) || [];
        const model = (p.model as string) || '';
        const dur = ms > 1000 ? `${(ms/1000).toFixed(1)}s` : `${ms}ms`;
        const toolsPart = tools.length ? ` using ${tools.slice(0, 3).map(t => toolVerb(t).replace(/^(running|reading|writing|editing|searching|fetching|posting|checking|saving|remembering|asking|opening|interacting|scheduling|drafting|generating|transcribing) (a |the )?/i, '')).join(', ')}` : '';
        return {
            titan: `Replied${toolsPart} (${dur})`,
            control: `Turn complete in ${dur}${tools.length ? ` tools=${tools.join(',')}` : ''}${model ? ` via ${model}` : ''}`,
            kind: 'channel',
            icon: '💬',
        };
    },

    // ── Tools ────────────────────────────────────────────────────
    'tool:call': (p) => {
        const tool = p.tool as string;
        return {
            titan: capitalize(toolVerb(tool)),
            control: `Tool start: ${tool}`,
            kind: 'tool',
            icon: toolIcon(tool),
        };
    },
    'tool:result': (p) => {
        const tool = p.tool as string;
        const success = p.success as boolean;
        if (!success) {
            return {
                titan: `${toolVerb(tool)} failed.`,
                control: `Tool fail: ${tool}`,
                kind: 'tool',
                icon: '⚠️',
            };
        }
        return {
            titan: `Finished ${toolVerb(tool)}.`,
            control: `Tool ok: ${tool} (${p.durationMs}ms)`,
            kind: 'tool',
            icon: toolIcon(tool),
        };
    },

    // ── Goals ────────────────────────────────────────────────────
    'goal:created': (p) => ({
        titan: `New goal: "${clip(p.title as string, 60)}"`,
        control: `Goal created: ${p.goalId}`,
        kind: 'goal',
        icon: '🎯',
    }),
    'goal:completed': (p) => ({
        titan: `Completed: "${clip(p.title as string, 60)}"`,
        control: `Goal completed: ${p.goalId}`,
        kind: 'goal',
        icon: '✅',
    }),
    'goal:progress': (p) => ({
        titan: `Progress on "${clip(p.title as string, 50)}" — ${p.progress}%`,
        control: `Goal progress: ${p.goalId} ${p.progress}%`,
        kind: 'goal',
        icon: '📈',
    }),
    'goal:failed': (p) => ({
        titan: `Hit a snag on "${clip(p.title as string, 50)}"`,
        control: `Goal fail: ${p.goalId} subtask=${p.subtaskId} err=${clip(p.error as string, 40)}`,
        kind: 'goal',
        icon: '⚠️',
        detail: clip(p.error as string, 80),
    }),
    'goal:subtask:ready': (p) => ({
        titan: `Picked up: "${clip(p.title as string, 60)}"`,
        control: `Subtask ready: ${p.subtaskId}`,
        kind: 'goal',
        icon: '🎯',
    }),
    'goal:subtask:added': (p) => ({
        titan: `Added a step: "${clip(p.title as string, 60)}"`,
        control: `Subtask added: ${p.subtaskId}`,
        kind: 'goal',
        icon: '➕',
    }),

    // ── Initiative / autopilot ───────────────────────────────────
    'initiative:start': (p) => ({
        titan: `Starting an autopilot run (${p.taskType || 'general'}).`,
        control: `Initiative start: ${p.taskType}`,
        kind: 'system',
        icon: '🤖',
    }),
    'initiative:complete': (p) => ({
        titan: p.success ? `Autopilot run done.` : `Autopilot run finished (rough).`,
        control: `Initiative complete success=${p.success} tools=${(p.toolsUsed as string[])?.length || 0}`,
        kind: 'system',
        icon: '🤖',
    }),
    'initiative:no_progress': (p) => ({
        titan: `Stalled on that — taking a breath.`,
        control: `Initiative no_progress: ${p.reason}`,
        kind: 'system',
        icon: '⏸',
    }),
    'initiative:round': (p) => ({
        titan: `Thinking (round ${p.round}/${p.maxRounds}).`,
        control: `Initiative round ${p.round}/${p.maxRounds}`,
        kind: 'system',
        icon: '🔄',
    }),

    // ── Command Post ─────────────────────────────────────────────
    'commandpost:task:checkout': (p) => ({
        titan: `Claimed a task.`,
        control: `Task checkout: ${p.subtaskId}`,
        kind: 'agent',
        icon: '📥',
    }),
    'commandpost:task:checkin': (p) => ({
        titan: `Turned in a task.`,
        control: `Task checkin: ${p.subtaskId}`,
        kind: 'agent',
        icon: '📤',
    }),
    'commandpost:task:expired': (p) => ({
        titan: `A task timed out, going to retry.`,
        control: `Task expired: ${p.subtaskId} agent=${p.agentId}`,
        kind: 'agent',
        icon: '⏰',
    }),
    'commandpost:budget:warning': (p) => ({
        titan: `Running low on budget (${p.pct}%).`,
        control: `Budget warning: ${p.policyId} at ${p.pct}%`,
        kind: 'health',
        icon: '💰',
    }),
    'commandpost:budget:exceeded': (p) => ({
        titan: `Hit budget — pausing that work.`,
        control: `Budget exceeded: ${p.policyId} action=${p.action}`,
        kind: 'health',
        icon: '🛑',
    }),
    'commandpost:agent:status': (p) => ({
        titan: `Agent ${p.agentId} is now ${p.status}.`,
        control: `Agent status: ${p.agentId} ${p.prev} → ${p.status}`,
        kind: 'agent',
        icon: '👤',
    }),

    // ── Daemon / health ──────────────────────────────────────────
    'daemon:started': () => ({
        titan: `Woke up — systems online.`,
        control: `Daemon started.`,
        kind: 'system',
        icon: '☀️',
    }),
    'daemon:paused': (p) => ({
        titan: `Taking a pause — ${p.reason || 'manual'}.`,
        control: `Daemon paused: ${p.reason}`,
        kind: 'system',
        icon: '⏸',
    }),
    'daemon:resumed': () => ({
        titan: `Back online.`,
        control: `Daemon resumed.`,
        kind: 'system',
        icon: '▶️',
    }),
    'cron:stuck': () => ({
        titan: `Noticed a scheduled job is overdue.`,
        control: `Cron stuck detected.`,
        kind: 'health',
        icon: '⚠️',
    }),
    'health:ollama:degraded': (p) => ({
        titan: `Ollama is slow — working around it.`,
        control: `Ollama degraded: HTTP ${p.status}`,
        kind: 'health',
        icon: '🔌',
    }),
    'health:ollama:down': () => ({
        titan: `Ollama is down — using cloud models.`,
        control: `Ollama unavailable.`,
        kind: 'health',
        icon: '❌',
    }),
    'dreaming:consolidated': () => ({
        titan: `Took a moment to consolidate memories.`,
        control: `Dreaming: memory consolidation complete.`,
        kind: 'memory',
        icon: '💭',
    }),

    // ── Multi-agent ──────────────────────────────────────────────
    'agent:spawned': (p) => ({
        titan: `Spun up a sub-agent: ${p.name}.`,
        control: `Agent spawned: ${p.id} name=${p.name} model=${p.model}`,
        kind: 'agent',
        icon: '🧬',
    }),
    'agent:stopped': (p) => ({
        titan: `Closed out sub-agent: ${p.name}.`,
        control: `Agent stopped: ${p.id}`,
        kind: 'agent',
        icon: '🧬',
    }),
    'agent:task:completed': (p) => ({
        titan: p.success ? `A sub-agent finished its task.` : `A sub-agent gave up on a task.`,
        control: `Agent task: ${p.agentId} success=${p.success} dur=${p.durationMs}ms`,
        kind: 'agent',
        icon: '🧬',
    }),
    'agent:task:failed': (p) => ({
        titan: `Sub-agent couldn't complete: ${clip(p.reason as string, 50)}.`,
        control: `Agent task failed: ${p.agentId} reason=${p.reason}`,
        kind: 'agent',
        icon: '⚠️',
    }),

    // ── Company (multi-agent org) ────────────────────────────────
    'company:goal:completed': (p) => ({
        titan: `A company hit a goal (${p.agentName || 'agent'}).`,
        control: `Company goal: ${p.goalId} success=${p.success}`,
        kind: 'goal',
        icon: '🏢',
    }),

    // ── Alerts ───────────────────────────────────────────────────
    'alert': (p) => ({
        titan: clip(p.message as string, 100),
        control: `[${p.severity}] ${p.title}: ${p.message}`,
        kind: 'health',
        icon: alertIcon(p.severity as string),
        detail: p.source as string,
    }),
};

// ── Icon helpers ───────────────────────────────────────────────
function toolIcon(tool: string): string {
    if (tool.startsWith('fb_')) return '📘';
    if (tool.startsWith('memory')) return '🧠';
    if (tool.startsWith('browser')) return '🌐';
    if (tool.startsWith('web_')) return '🔎';
    if (tool.startsWith('shell') || tool === 'code_exec') return '⌨️';
    if (tool.includes('email')) return '✉️';
    if (tool.includes('voice')) return '🎙️';
    if (tool.includes('image')) return '🖼️';
    if (tool.includes('goal')) return '🎯';
    if (tool.includes('cron')) return '⏰';
    return '🛠️';
}

function channelIcon(channel: string): string {
    if (channel.startsWith('messenger')) return '💬';
    if (channel.startsWith('twilio')) return '📞';
    if (channel === 'webchat') return '💭';
    if (channel === 'api') return '🔌';
    if (channel === 'initiative' || channel.startsWith('initiative')) return '🤖';
    return '📡';
}

function alertIcon(severity: string): string {
    if (severity === 'critical' || severity === 'error') return '🚨';
    if (severity === 'warning') return '⚠️';
    return '🔔';
}

function capitalize(s: string): string {
    return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Public API ─────────────────────────────────────────────────

/** Humanize a raw event. Returns a WatchEvent or null if we choose to skip. */
export function humanize(
    topic: string,
    payload: Record<string, unknown>,
    id?: string,
): WatchEvent | null {
    // Dedupe noisy heartbeats — only emit them when asked
    if (topic === 'daemon:heartbeat'
        || topic === 'commandpost:agent:heartbeat'
        || topic === 'company:heartbeat'
        || topic === 'soul:heartbeat') return null;

    const fn = H[topic];
    const ts = (payload.timestamp as number) || Date.now();

    if (fn) {
        const { titan, control, kind, icon, detail } = fn(payload);
        return {
            id: id || `${topic}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: ts,
            topic,
            kind,
            icon,
            captionTitan: titan,
            captionControl: control,
            detail,
            raw: payload,
        };
    }

    // Fallback for uncatalogued events — surface them as "system" so we see
    // them in the stream and know to add a template later.
    return {
        id: id || `${topic}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: ts,
        topic,
        kind: 'system',
        icon: '•',
        captionTitan: `Something happened (${topic}).`,
        captionControl: topic,
        raw: payload,
    };
}

/** Return all known topics we can humanize (for debugging). */
export function knownTopics(): string[] {
    return Object.keys(H);
}
