/**
 * TITAN — Widget side-channel emitter.
 *
 * Why this exists
 * ---------------
 * The canvas (Mission Control v2 → TitanCanvas) creates widgets in TWO ways:
 *
 *   1. The agent emits a `_____react` / `_____widget` fenced block in its
 *      assistant text. The frontend's protocol parser
 *      (`ui/src/titan2/agent/protocol.ts`) catches the gate and dispatches a
 *      `render_widget` action through SpaceEngine.
 *
 *   2. The user clicks something in the Gallery / QuickLinks / etc.
 *
 * Path (1) is fragile because small models routinely forget the fence,
 * truncate the source, or wrap the gate in markdown. The agent is
 * "supposed to" emit a widget but there's no programmatic action it can
 * take that BYPASSES the text-emission step.
 *
 * This module is that programmatic action. A skill (e.g. `create_widget`)
 * resolves a widget definition server-side, then calls
 * {@link emitWidget}; the gateway's SSE stream forwards the event to the
 * active frontend; ChatWidget.tsx routes it directly into SpaceEngine —
 * no fence, no model emission, no chance of truncation.
 *
 * The side-channel is **per-session**. Each `/api/message` SSE handler
 * subscribes for the duration of its stream via {@link subscribe}, gets
 * widget events for its sessionId only, and forwards them as
 * `event: widget` SSE frames. When the stream ends (or the client
 * disconnects) the subscription is released — no global state leak.
 *
 * Reference:
 *   - awesome-agent-harness top-10 pattern #6
 *     (Sync / async / human-in-the-loop separation — UI side effects belong
 *     on their own channel, not muxed into the assistant text)
 *   - 12 Factor Agents §3 "Own your context window"
 */

import { EventEmitter } from 'node:events';

/**
 * The canonical widget envelope server-side tools fire onto the channel.
 * Mirrors `ui/src/titan2/types.ts` WidgetDef but with all positional /
 * timestamp fields optional — the frontend fills sensible defaults.
 *
 * Keep this shape in lockstep with the frontend WidgetDef. If the UI gets
 * a new required field, add it here too.
 */
export interface WidgetEnvelope {
    /** Display name (required — used as title + identifier in the UI). */
    name: string;
    /** Optional explicit widget id. When present + the id already exists,
     *  the canvas treats this as an UPDATE rather than a create. */
    id?: string;
    /** Optional user-visible title bar text. Defaults to `name`. */
    title?: string;
    /** Render format. Defaults to 'react'. */
    format?: 'react' | 'vanilla' | 'html' | 'iframe' | 'system';
    /** The widget source — React JSX/TSX, raw HTML, an iframe URL, or
     *  a `system:xxx` reference for built-in panels. */
    source: string;
    /** Grid column position (default: auto-place by canvas). */
    x?: number;
    /** Grid row position. */
    y?: number;
    /** Width in grid units (1–12). Defaults to 4. */
    w?: number;
    /** Height in grid units. Defaults to 4. */
    h?: number;
    /** Free-form metadata bag (template id, fill values, etc.). */
    metadata?: Record<string, unknown>;
}

/** Mode the frontend should apply when it receives the envelope. */
export type WidgetEventMode = 'create' | 'update' | 'remove';

/** The full event payload pushed onto the per-session bus. */
export interface WidgetEvent {
    /** Routing key — the SSE forwarder ignores events for other sessions. */
    sessionId: string;
    /** What to do with the envelope on the canvas. */
    mode: WidgetEventMode;
    /** The widget definition. For `remove`, only `id` is required. */
    widget: WidgetEnvelope;
    /** Server clock so the frontend can dedupe replays. */
    timestamp: number;
}

/** The unsubscribe handle returned by {@link subscribe}. Calling it stops
 *  delivery and releases the listener. */
export type WidgetUnsubscribe = () => void;

/**
 * Module-scoped emitter. Node's EventEmitter is fine here — widget bursts
 * are small (one or two per chat turn) and we're single-process. If TITAN
 * later sharded across workers this would need to move to Redis pub/sub
 * or similar; flagged in code so the swap is obvious.
 */
const bus = new EventEmitter();
// We intentionally raise the cap above the Node default of 10 — Mission
// Control can have multiple SSE streams open (chat + watcher + dashboards)
// against the same session during a power-user workflow.
bus.setMaxListeners(64);

const CHANNEL = 'widget';

/**
 * Subscribe to widget events for a single session. The returned function
 * unsubscribes; ALWAYS call it on stream close to prevent listener leak.
 */
export function subscribe(sessionId: string, handler: (evt: WidgetEvent) => void): WidgetUnsubscribe {
    if (!sessionId) {
        // No-op subscription. We never want a listener that fires for every
        // session (would be a privacy/scope bug).
        return () => { /* no-op */ };
    }
    const listener = (evt: WidgetEvent) => {
        if (evt.sessionId !== sessionId) return;
        try { handler(evt); } catch { /* never let a handler throw kill the bus */ }
    };
    bus.on(CHANNEL, listener);
    return () => { bus.removeListener(CHANNEL, listener); };
}

/**
 * Fire a `create` widget event for the active session. Returns true if
 * any subscriber received it, false otherwise (no SSE stream open — the
 * tool should still return a confirmation string so the model knows
 * structurally what happened, but the widget won't be visible until the
 * user reconnects).
 */
export function emitWidget(sessionId: string, widget: WidgetEnvelope, mode: WidgetEventMode = 'create'): boolean {
    if (!sessionId) return false;
    if (!widget || typeof widget !== 'object') return false;
    if (mode !== 'remove' && !widget.source) return false;
    const evt: WidgetEvent = {
        sessionId,
        mode,
        widget,
        timestamp: Date.now(),
    };
    // EventEmitter.emit returns true if any listeners fired.
    return bus.emit(CHANNEL, evt);
}

/**
 * Test/diagnostic helper — drop all listeners. Production code never calls
 * this; tests use it to isolate cases.
 */
export function __resetWidgetBusForTests(): void {
    bus.removeAllListeners(CHANNEL);
}
