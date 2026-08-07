/**
 * TITAN — Room cursor state machine (v8 Slice 1)
 *
 * The pure, framework-free catch-up/live-merge logic behind the company
 * room (re-review fix, event 340a6788). The UI (CompanyRoom.tsx) wires it
 * to its EventSource and REST client; tests drive it with scripted fakes.
 *
 * INVARIANTS
 *  - The cursor is the highest seq DELIVERED CONTIGUOUSLY. A live event
 *    advances it directly ONLY when seq === cursor + 1. Any larger jump
 *    buffers the event and triggers catch-up: the REST log is the sole
 *    authority on what lies between (this also makes seq HOLES safe —
 *    SQLite AUTOINCREMENT skips seqs on aborted inserts, so a jump is not
 *    proof of missing data; the fetch resolves which it was).
 *  - Catch-up never stops at a partial page while a buffered live event
 *    lies beyond the cursor; it keeps fetching until the cursor covers
 *    the highest buffered seq.
 *  - A fetch failure RETRIES (bounded, injectable delay) without letting
 *    any live event advance the cursor across the unfetched gap; if
 *    retries exhaust, onExhausted fires so the caller can force an SSE
 *    reconnect — the buffer is preserved and no seq is ever skipped.
 *  - Everything delivered is deduped by id and emitted in seq order.
 */

export interface RoomEventLike {
    seq: number;
    id: string;
}

export interface RoomCursorOptions<E extends RoomEventLike> {
    /** Fetch events with seq > after, up to limit, in seq order (REST). */
    fetchPage: (after: number, limit: number) => Promise<E[]>;
    /** Deliver events to the consumer, already deduped and seq-ordered. */
    emit: (events: E[]) => void;
    /** Called when catch-up retries exhaust — caller should force a reconnect. */
    onExhausted?: () => void;
    pageSize?: number;
    maxRetries?: number;
    /** Injectable retry delay (default: immediate in tests, caller supplies real backoff). */
    retryDelay?: () => Promise<void>;
}

export class RoomCursor<E extends RoomEventLike> {
    /** Highest contiguously-delivered seq. */
    cursor = 0;
    private buffer = new Map<string, E>();
    private delivered = new Set<string>();
    private inflight: Promise<void> | null = null;
    private opts: Required<Pick<RoomCursorOptions<E>, 'pageSize' | 'maxRetries'>> & RoomCursorOptions<E>;

    constructor(opts: RoomCursorOptions<E>) {
        this.opts = { pageSize: 500, maxRetries: 5, ...opts };
    }

    /** A live (SSE) event arrived. */
    onLive(event: E): void {
        if (this.delivered.has(event.id) || event.seq <= this.cursor) return; // duplicate
        if (!this.inflight && event.seq === this.cursor + 1 && this.buffer.size === 0) {
            // Provably contiguous: nothing can lie between cursor and cursor+1.
            this.deliver([event]);
            return;
        }
        // A jump, or catch-up in flight: buffer and let the fetch decide.
        this.buffer.set(event.id, event);
        void this.catchUp();
    }

    /** Run catch-up until the cursor covers tail + all buffered seqs.
     *  JOIN semantics: if a run is already in flight, await ITS completion —
     *  callers can rely on "after await catchUp(), the cursor is settled". */
    catchUp(): Promise<void> {
        if (this.inflight) return this.inflight;
        this.inflight = this.runCatchUp().finally(() => { this.inflight = null; });
        return this.inflight;
    }

    private async runCatchUp(): Promise<void> {
        let retries = 0;
        {
            while (true) {
                let page: E[];
                try {
                    page = await this.opts.fetchPage(this.cursor, this.opts.pageSize);
                    retries = 0;
                } catch {
                    retries += 1;
                    if (retries > this.opts.maxRetries) {
                        // Preserve the buffer; never advance across the gap.
                        this.opts.onExhausted?.();
                        return;
                    }
                    if (this.opts.retryDelay) await this.opts.retryDelay();
                    continue;
                }
                if (page.length > 0) {
                    this.deliver(page);
                }
                if (page.length === this.opts.pageSize) continue;   // more persisted rows
                const liveTarget = this.highestBufferedSeq();
                if (liveTarget > this.cursor) continue;             // live ran ahead — fetch the gap
                break;                                              // contiguous through the live target
            }
            // Everything buffered is now ≤ cursor: fetched authoritatively
            // (or a duplicate of a delivered row). Drop the buffer.
            this.buffer.clear();
        }
    }

    /** For status surfaces/tests. */
    pendingBufferSize(): number {
        return this.buffer.size;
    }

    private highestBufferedSeq(): number {
        let max = 0;
        for (const e of this.buffer.values()) max = Math.max(max, e.seq);
        return max;
    }

    private deliver(events: E[]): void {
        const fresh = events
            .filter(e => !this.delivered.has(e.id))
            .sort((a, b) => a.seq - b.seq);
        if (fresh.length === 0) return;
        for (const e of fresh) this.delivered.add(e.id);
        this.cursor = Math.max(this.cursor, fresh[fresh.length - 1].seq);
        this.opts.emit(fresh);
    }
}
