/**
 * TITAN — Canvas Widget Tools (Built-in)
 *
 * Why this skill exists
 * ---------------------
 * The agent has been able to *show* widgets on the canvas since v4.x by
 * emitting a `_____react` fence in its assistant text. That works in
 * principle but is fragile in practice — small models forget the fence,
 * truncate the source, wrap the gate in markdown, or paste the source
 * twice. The user (Tony, repeatedly) reports: "TITAN should be able to
 * just CREATE the widget when I ask."
 *
 * This skill is that programmatic path. Each tool resolves a widget
 * definition server-side, fires a `widget` event onto the per-session
 * side-channel (see `src/agent/widgetEmitter.ts`), and returns a short
 * confirmation string so the model knows the action succeeded. The
 * gateway's `/api/message` SSE handler forwards the side-channel event
 * to the React SPA as an `event: widget` SSE frame, and ChatWidget pipes
 * it into `SpaceEngine.addWidget` (or update/remove) directly.
 *
 * Net result: the agent says "create me a clock widget" → it calls
 * `create_widget({ template: "clock" })` → the canvas shows the clock
 * instantly. The model never has to emit a fence; if it does anyway,
 * the existing `_____react` parser still works as a fallback.
 *
 * Tool contract design follows v5.8.0 standards:
 *   - Anthropic checklist description (Use Case / Anti-pattern / Params
 *     / Returns / Errors).
 *   - Silent-on-success: a successful call returns a single-line
 *     confirmation, not a JSON dump.
 *   - Output-cap aware: returns are tiny (under 200 chars typical).
 *
 * Reference:
 *   - awesome-agent-harness top-10 pattern #6
 *     (Sync / async / human-in-the-loop separation — UI actions belong
 *     on their own channel)
 *   - Anthropic, "Writing effective tools for AI agents"
 */
import { registerSkill } from '../registry.js';
import { getCurrentSessionId } from '../../agent/agent.js';
import { emitWidget, type WidgetEnvelope } from '../../agent/widgetEmitter.js';
import { getTemplate } from './widget_gallery.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'CanvasWidgets';

/** Reasonable default sizes (in 12-column grid units) for new widgets. */
const DEFAULT_W = 4;
const DEFAULT_H = 4;
const MAX_W = 12;
const MAX_H = 12;

/** Generate a short, URL-safe id for a new widget. Frontend will accept
 *  whatever id we pass; this keeps the convention readable. */
function newWidgetId(): string {
    // 8 hex chars is plenty — collisions in a single-user canvas are
    // vanishingly rare and the frontend treats any string as opaque.
    return 'w-' + Math.random().toString(16).slice(2, 10) + '-' + Date.now().toString(36).slice(-4);
}

/** Clamp a grid dimension to the canvas's actual range. */
function clamp(n: unknown, fallback: number, max: number): number {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
    if (v < 1) return 1;
    if (v > max) return max;
    return v;
}

/**
 * v6.0 — Reliability hardening for the create_widget input layer.
 *
 * Observed in production logs:
 *   - Models sometimes pass `name: "__WIDGET_META__ w=6 h=6"` (the meta
 *     comment from the source file, not an actual name).
 *   - Models sometimes pass `format: "jsx"` / `"tsx"` / `"javascript"`
 *     instead of the documented `react` literal — these silently fell
 *     through and rendered as `react` anyway, but type-wise wrong.
 *   - Models embed `// __WIDGET_META__ w=N h=M` at the top of source but
 *     pass no w/h, expecting them to be auto-parsed.
 *
 * These three helpers normalize the inputs before the envelope is built.
 */

/** Coerce any model-flavor format string to a valid WidgetFormat. */
function normalizeFormat(raw: unknown): WidgetEnvelope['format'] {
    if (typeof raw !== 'string') return 'react';
    const s = raw.toLowerCase().trim();
    if (s === 'react' || s === 'jsx' || s === 'tsx' || s === 'javascript' || s === 'js') return 'react';
    if (s === 'vanilla') return 'vanilla';
    if (s === 'html') return 'html';
    if (s === 'iframe') return 'iframe';
    if (s === 'system') return 'system';
    return 'react';
}

/** Strip junk patterns the model sometimes passes as a "name". */
function normalizeName(raw: string): string {
    let s = raw.trim();
    // The classic offender — meta comment used as name.
    if (s.startsWith('__WIDGET_META__')) return '';
    // Strip leading comment markers + whitespace.
    s = s.replace(/^[/*\s]+/, '').replace(/\*+\/$/, '').trim();
    // Cap at 60 chars.
    return s.slice(0, 60);
}

/** Look for `// __WIDGET_META__ w=N h=M` in source and return parsed dims. */
function extractMetaDims(source: string): { w?: number; h?: number } {
    const m = source.match(/\/\/\s*__WIDGET_META__\s+w\s*=\s*(\d+)\s+h\s*=\s*(\d+)/);
    if (!m) return {};
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    return {
        w: Number.isFinite(w) && w > 0 ? w : undefined,
        h: Number.isFinite(h) && h > 0 ? h : undefined,
    };
}

/**
 * v6.0 — Known X-Frame-blocked hosts. When the agent writes
 * `<iframe src="https://www.<host>...">` against any of these, the
 * resulting panel renders blank inside the canvas iframe because the
 * destination site sends `X-Frame-Options: DENY` or `SAMEORIGIN` (or
 * a `Content-Security-Policy: frame-ancestors` directive).
 *
 * Not exhaustive — these are the big ones the agent tends to reach for
 * when the user says "make me an X widget" for some popular site. We
 * surface the host the agent picked so the error message is concrete.
 */
const BLOCKED_IFRAME_HOSTS = [
    'google.com',
    'www.google.com',
    'mail.google.com',
    'docs.google.com',
    'youtube.com',
    'www.youtube.com',
    'ebay.com',
    'www.ebay.com',
    'amazon.com',
    'www.amazon.com',
    'facebook.com',
    'www.facebook.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'linkedin.com',
    'github.com',           // github.com sends DENY for many paths
    'reddit.com',
    'gmail.com',
    'paypal.com',
    'apple.com',
    'icloud.com',
    'netflix.com',
    'spotify.com',
];

/** Scan source for an iframe whose host matches the blocklist.
 *  Returns the matched host (so the error message can name it) or null. */
function detectBlockedIframeHost(source: string): string | null {
    if (!source || !/<iframe\b/i.test(source)) return null;
    // Match iframe src= with the URL quoted in single, double, or backtick.
    const iframeRe = /<iframe[^>]+src\s*=\s*(['"`])([^'"`]+)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = iframeRe.exec(source)) !== null) {
        const rawUrl = m[2];
        try {
            // Allow relative URLs and same-origin paths — those route
            // through TITAN's gateway and don't have the X-Frame problem.
            if (rawUrl.startsWith('/') || rawUrl.startsWith('#')) continue;
            const u = new URL(rawUrl);
            const host = u.host.toLowerCase();
            for (const blocked of BLOCKED_IFRAME_HOSTS) {
                if (host === blocked || host.endsWith('.' + blocked)) {
                    return `${u.protocol}//${host}`;
                }
            }
        } catch {
            // Malformed URL — skip; the sandbox will reject it on its own.
        }
    }
    return null;
}

/** Detect a component name from raw React source. */
function extractComponentName(source: string): string | null {
    // Match `function Foo`, `const Foo =`, `class Foo`, `export default function Foo`.
    const patterns = [
        /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/,
        /function\s+([A-Z][A-Za-z0-9_]*)\s*\(/,
        /const\s+([A-Z][A-Za-z0-9_]*)\s*=/,
        /let\s+([A-Z][A-Za-z0-9_]*)\s*=/,
        /class\s+([A-Z][A-Za-z0-9_]*)/,
    ];
    for (const re of patterns) {
        const m = source.match(re);
        if (m && m[1]) return m[1];
    }
    return null;
}

/** Resolve a widget envelope from the tool args. Returns either a ready
 *  envelope or an Error string the tool can return verbatim. */
function resolveEnvelope(args: Record<string, unknown>): WidgetEnvelope | string {
    const name = typeof args.name === 'string' ? normalizeName(args.name) : '';
    const template = typeof args.template === 'string' ? args.template.trim() : '';
    const source = typeof args.source === 'string' ? args.source : '';
    const format = normalizeFormat(args.format);
    const fill = (args.fill && typeof args.fill === 'object' && !Array.isArray(args.fill))
        ? (args.fill as Record<string, string>)
        : undefined;

    let resolvedSource = source;
    let resolvedName = name;
    let resolvedW: number | undefined;
    let resolvedH: number | undefined;
    let resolvedFormat: WidgetEnvelope['format'] = format;
    const metadata: Record<string, unknown> = {};

    if (template) {
        const t = getTemplate(template, fill);
        if (!t) {
            return `Error: template "${template}" not found in the gallery. Call gallery_search first to find a valid id, or pass raw \`source\` directly.`;
        }
        resolvedSource = t.source;
        resolvedName = resolvedName || t.name;
        resolvedW = t.defaultSize?.w;
        resolvedH = t.defaultSize?.h;
        // System widgets ship with `source: "system:xxx"` and need format=system.
        if (resolvedSource.startsWith('system:')) {
            resolvedFormat = 'system';
        }
        metadata.templateId = template;
        if (fill && Object.keys(fill).length > 0) {
            metadata.fill = fill;
        }
    } else if (!resolvedSource) {
        return 'Error: either "template" (a gallery id) or "source" (raw widget code) is required.';
    }

    if (!resolvedName) {
        // v6.0 — Better name extraction in priority order:
        // 1. Pull a React component name from the source (matches what the
        //    sandbox runtime auto-detects anyway, so we stay in sync).
        // 2. Fall back to the first non-comment line.
        const compName = extractComponentName(resolvedSource);
        if (compName) {
            resolvedName = compName;
        } else {
            const firstNonMetaLine = resolvedSource.split(/\r?\n/)
                .find(l => l.trim().length > 0 && !l.includes('__WIDGET_META__'))
                || 'Widget';
            resolvedName = firstNonMetaLine.replace(/^[/*\s]+/, '').slice(0, 40) || 'Widget';
        }
    }

    // v6.0 — If the source carries an inline `__WIDGET_META__ w=N h=M`
    // comment and the caller didn't pass explicit w/h, use those dims.
    // This matches the convention the canvas frontend has used for ages.
    const metaDims = extractMetaDims(resolvedSource);
    const finalW = args.w ?? resolvedW ?? metaDims.w;
    const finalH = args.h ?? resolvedH ?? metaDims.h;

    // v6.0 — Pre-flight check: detect iframe sources that point at hosts
    // known to send X-Frame-Options: DENY / SAMEORIGIN. These render as
    // blank/error inside the canvas iframe, which is exactly what bit the
    // eBay and Google widgets. Reject early with an actionable error so
    // the agent retries with `/api/proxy` (server-side HTML fetch) or a
    // search-form-that-opens-in-new-tab instead.
    //
    // Reference: ChatWidget.tsx system prompt section "X-Frame-Options
    // blocked sites" already documents the workaround; this is the
    // enforcement layer so the model can't ignore the guidance.
    const blockedIframeHost = detectBlockedIframeHost(resolvedSource);
    if (blockedIframeHost) {
        return [
            `Error: widget source contains an <iframe src="${blockedIframeHost}…"> but that host blocks embedding (X-Frame-Options or CSP frame-ancestors).`,
            ``,
            `The widget will render as a blank/broken panel. Pick ONE of these alternatives:`,
            `  1. Use \`titan.api.call("/api/proxy", { url: "${blockedIframeHost}…" })\` inside a React widget and render the returned HTML via dangerouslySetInnerHTML. The gateway fetches server-side and returns it without the X-Frame headers. (Note: links won't navigate; it's a snapshot.)`,
            `  2. Use the \`browser_screenshot\` tool to capture a screenshot of the page first, then render the image inside a widget. Use this when interaction isn't needed.`,
            `  3. Build a search-form widget that opens results in a NEW TAB (target="_blank") instead of trying to embed the destination page.`,
            ``,
            `Retry \`create_widget\` with one of the above approaches.`,
        ].join('\n');
    }

    const envelope: WidgetEnvelope = {
        name: resolvedName,
        title: typeof args.title === 'string' ? args.title : resolvedName,
        format: resolvedFormat,
        source: resolvedSource,
        w: clamp(finalW, DEFAULT_W, MAX_W),
        h: clamp(finalH, DEFAULT_H, MAX_H),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    // x/y are optional — when omitted, the frontend's SpaceEngine auto-places
    // (next free slot in row order). Only forward when explicitly provided.
    if (typeof args.x === 'number') envelope.x = clamp(args.x, 0, MAX_W);
    if (typeof args.y === 'number') envelope.y = Math.max(0, Math.floor(args.y));

    return envelope;
}

// ─── Tool: create_widget ────────────────────────────────────────────

const createHandler = {
    name: 'create_widget',
    description: [
        'Create a new widget on the user\'s active canvas space. The widget appears immediately — the user does not have to refresh.',
        '',
        'USE CASE: the user asks for a clock, a weather panel, a custom dashboard, a system panel (training, vram, cron, etc.), or any visual surface.',
        'ANTI-PATTERN: do NOT also paste a `_____react` fence in your reply — the widget is created via this tool\'s side-channel; emitting a fence too will create duplicates.',
        '',
        'TWO WAYS TO CALL IT:',
        '  1. PREFERRED — `template: "<gallery-id>"` (+ optional `fill` map for placeholders). Resolves verified source from the gallery. Pair with `gallery_search` first to find the right id.',
        '  2. ADVANCED — `source: "<raw React code>"` with `name` and optional `w`/`h`. Use only when no gallery template fits.',
        '',
        'PARAMETERS:',
        '  • name           — display name (required when using `source`; auto-filled from the template otherwise).',
        '  • template       — gallery template id (e.g. "clock", "weather", "system-training"). Prefer this.',
        '  • source         — raw React/HTML/iframe source. Only when `template` is not used.',
        '  • format         — "react" (default) | "vanilla" | "html" | "iframe" | "system".',
        '  • fill           — placeholder map for templates: {ZIP: "95451", CITY: "Kelseyville"}.',
        '  • title          — custom title bar text. Defaults to `name`.',
        '  • w, h           — grid size (1–12 each). Defaults: 4×4 or template default.',
        '  • x, y           — explicit grid coordinates. Omit to auto-place.',
        '',
        'RETURNS: "Created widget \'<name>\' (id: <id>, <w>×<h>) on the active canvas." on success.',
        'ERRORS: "Error: ..." when no source/template, unknown template id, or no active session.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Display name for the widget. Required when using `source`; optional when using `template`.' },
            template: { type: 'string', description: 'Gallery template id (call gallery_search to find one). Preferred over raw source.' },
            source: { type: 'string', description: 'Raw widget source (React JSX/TSX, HTML, iframe URL, or `system:xxx`). Use when no template fits.' },
            format: { type: 'string', enum: ['react', 'vanilla', 'html', 'iframe', 'system'], description: 'Render format. Defaults to "react".' },
            fill: { type: 'object', description: 'Placeholder substitution map for templates (e.g. {ZIP:"95451"}).' },
            title: { type: 'string', description: 'Custom title bar text. Defaults to `name`.' },
            w: { type: 'number', description: 'Width in grid units (1-12). Default: 4 or template default.' },
            h: { type: 'number', description: 'Height in grid units (1-12). Default: 4 or template default.' },
            x: { type: 'number', description: 'Optional explicit grid column.' },
            y: { type: 'number', description: 'Optional explicit grid row.' },
        },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const sessionId = getCurrentSessionId();
        if (!sessionId) {
            return 'Error: no active session — create_widget can only run inside a chat turn where the canvas is listening.';
        }

        const envelope = resolveEnvelope(args);
        if (typeof envelope === 'string') return envelope; // already-formatted error

        const delivered = emitWidget(sessionId, envelope, 'create');
        // v6.0 — Diagnostic logging: dump a source preview so widget render
        // failures are debuggable from titan.log alone. Previously only
        // name/format/dims/delivered were captured, which made post-mortems
        // ("the eBay widget failed") impossible — we couldn't see what the
        // model actually wrote. Source is multi-line so we render it as a
        // single line with literal \n for grepability.
        const sourcePreview = (envelope.source || '')
            .slice(0, 280)
            .replace(/\r?\n/g, '\\n');
        const sourceLineCount = (envelope.source || '').split(/\r?\n/).length;
        const sourceLen = (envelope.source || '').length;
        const hasIframe = /<iframe\b/i.test(envelope.source || '');
        const iframeNote = hasIframe ? ' [contains <iframe>]' : '';
        logger.info(COMPONENT, `create_widget "${envelope.name}" (${envelope.format}, ${envelope.w}x${envelope.h}, src=${sourceLen}c/${sourceLineCount}L${iframeNote}) — delivered=${delivered}`);
        logger.info(COMPONENT, `create_widget source preview: ${sourcePreview}`);

        if (!delivered) {
            // The tool succeeded structurally but no canvas listener heard it.
            // This happens when the user is on a non-streaming endpoint or has
            // closed the tab. Tell the model the truth so it doesn't claim the
            // widget is visible.
            return `Widget prepared (name: "${envelope.name}", ${envelope.w}×${envelope.h}) but no canvas listener is connected. The user may need to reopen the chat for the widget to appear.`;
        }
        return `Created widget "${envelope.name}" (${envelope.w}×${envelope.h}, format=${envelope.format}) on the active canvas.`;
    },
};

// ─── Tool: update_widget ────────────────────────────────────────────

const updateHandler = {
    name: 'update_widget',
    description: [
        'Update an existing widget on the active canvas. Use when the user asks to "change the X widget" or "make the clock bigger".',
        '',
        'USE CASE: user says "make the weather widget show Kelseyville", "resize the clock to 6×6", "rename it".',
        'ANTI-PATTERN: do NOT call create_widget when the user wants an edit — that produces a duplicate.',
        '',
        'PARAMETERS:',
        '  • id             — REQUIRED. The widget id you want to update (use list_widgets to find it).',
        '  • source         — new widget code (optional).',
        '  • name / title   — new display name / title (optional).',
        '  • w / h          — new grid size (optional).',
        '  • format         — new render format (optional).',
        '',
        'RETURNS: "Updated widget <id>." on success.',
        'ERRORS: "Error: ..." when id is missing or no active session.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Existing widget id to update.' },
            source: { type: 'string', description: 'New source code (optional).' },
            name: { type: 'string', description: 'New display name (optional).' },
            title: { type: 'string', description: 'New title bar text (optional).' },
            format: { type: 'string', enum: ['react', 'vanilla', 'html', 'iframe', 'system'], description: 'New render format (optional).' },
            w: { type: 'number', description: 'New width 1-12 (optional).' },
            h: { type: 'number', description: 'New height 1-12 (optional).' },
        },
        required: ['id'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const sessionId = getCurrentSessionId();
        if (!sessionId) return 'Error: no active session — update_widget can only run inside a chat turn.';

        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return 'Error: "id" is required. Use list_widgets to find the id of the widget you want to change.';

        const envelope: WidgetEnvelope = {
            id,
            // `name` and `source` carry the partial update. Frontend treats
            // any present field as a patch; absent fields are left untouched.
            name: typeof args.name === 'string' ? args.name : '',
            source: typeof args.source === 'string' ? args.source : '',
        };
        if (typeof args.title === 'string') envelope.title = args.title;
        if (typeof args.format === 'string') envelope.format = args.format as WidgetEnvelope['format'];
        if (typeof args.w === 'number') envelope.w = clamp(args.w, DEFAULT_W, MAX_W);
        if (typeof args.h === 'number') envelope.h = clamp(args.h, DEFAULT_H, MAX_H);

        const delivered = emitWidget(sessionId, envelope, 'update');
        logger.info(COMPONENT, `update_widget id=${id} — delivered=${delivered}`);
        return delivered
            ? `Updated widget ${id}.`
            : `Update prepared for widget ${id} but no canvas listener is connected.`;
    },
};

// ─── Tool: remove_widget ────────────────────────────────────────────

const removeHandler = {
    name: 'remove_widget',
    description: [
        'Remove a widget from the active canvas. Use when the user says "close the clock", "remove the weather widget", "delete that panel".',
        '',
        'PARAMETERS:',
        '  • id  — REQUIRED. Widget id to remove. Use list_widgets to find it.',
        '',
        'RETURNS: "Removed widget <id>." on success.',
        'ERRORS: "Error: ..." when id is missing or no active session.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Existing widget id to remove.' },
        },
        required: ['id'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const sessionId = getCurrentSessionId();
        if (!sessionId) return 'Error: no active session — remove_widget can only run inside a chat turn.';
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return 'Error: "id" is required.';

        // For remove, the envelope only needs id; source is unused by the
        // frontend `remove` path but the type requires it — pass empty string.
        const delivered = emitWidget(sessionId, { id, name: '', source: '' }, 'remove');
        logger.info(COMPONENT, `remove_widget id=${id} — delivered=${delivered}`);
        return delivered
            ? `Removed widget ${id}.`
            : `Removal prepared for widget ${id} but no canvas listener is connected.`;
    },
};

// ─── Tool: list_active_widgets (v6.0 — canvas self-awareness) ──────

const listActiveHandler = {
    name: 'list_active_widgets',
    description: [
        'List the widgets currently pinned to the user\'s ACTIVE Space. Use BEFORE create_widget when the user references something that "might already be on the canvas" — to avoid creating duplicates. Use BEFORE update_widget to find the id of the widget you mean to change.',
        '',
        'USE CASE: user says "is there a clock on the canvas?", "what widgets do I have right now?", "update my BPM tracker" (need to find its id first).',
        'ANTI-PATTERN: don\'t poll this every turn. It costs no tokens to call, but call it only when canvas state actually matters for the next action.',
        '',
        'PARAMETERS: none.',
        '',
        'RETURNS: A markdown table with id / name / format / w×h for each widget on the active Space, plus the Space name. "No widgets on active Space" when empty.',
        'ERRORS: "Error: ..." when no active Space exists yet.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
    execute: async (): Promise<string> => {
        try {
            const { getActiveSpace } = await import('../../storage/spaces.js');
            const space = getActiveSpace();
            if (!space) return 'Error: no active Space. Use create_space to make one, or switch_space to activate an existing one.';
            const widgets = Array.isArray(space.widgets) ? space.widgets : [];
            if (widgets.length === 0) {
                return `Active Space: ${space.icon ? space.icon + ' ' : ''}${space.name} (id: ${space.id}) — canvas is empty. Pin widgets via create_widget.`;
            }
            const lines = [
                `Active Space: ${space.icon ? space.icon + ' ' : ''}${space.name} (id: ${space.id}). ${widgets.length} widget(s) on canvas:`,
                '',
                '| id | name | format | w×h |',
                '|----|------|--------|-----|',
            ];
            for (const raw of widgets) {
                const w = raw as { id?: string; name?: string; format?: string; w?: number; h?: number };
                lines.push(`| \`${w.id ?? '?'}\` | ${w.name ?? '?'} | ${w.format ?? '?'} | ${w.w ?? '?'}×${w.h ?? '?'} |`);
            }
            return lines.join('\n');
        } catch (err) {
            return `Error: list_active_widgets failed — ${(err as Error).message}`;
        }
    },
};

// ─── Registration ──────────────────────────────────────────────────

export function registerCanvasWidgetsSkill(): void {
    const meta = {
        name: 'canvas-widgets',
        description: 'Programmatic canvas-widget control — create, update, remove, and inspect widgets on the active space without emitting a `_____react` fence.',
        version: '1.1.0',
        source: 'bundled' as const,
        enabled: true,
    };
    registerSkill(meta, createHandler);
    registerSkill(meta, updateHandler);
    registerSkill(meta, removeHandler);
    registerSkill(meta, listActiveHandler);
}

// Exported for tests.
export const __test__ = {
    resolveEnvelope,
    newWidgetId,
    clamp,
    detectBlockedIframeHost,
    normalizeFormat,
    normalizeName,
    extractMetaDims,
    extractComponentName,
};
