/**
 * TITAN — v8 Slice 1: room cursor state machine (deterministic, no jsdom).
 *
 * Honey's three required scenarios (event 340a6788) plus the seq-hole case:
 *  (a) backlog > 500 paginates fully
 *  (b) partial page + live event beyond it → the gap is fetched before merge
 *  (c) fetch failure followed by a HIGHER live event → cursor never advances
 *      across the gap; retry delivers everything in order
 *  (+) seq holes (aborted inserts) do not deadlock the contiguity rule
 */
import { describe, it, expect } from 'vitest';
import { RoomCursor, type RoomEventLike } from '../src/company/roomCursor.js';

interface Ev extends RoomEventLike { seq: number; id: string }
const ev = (seq: number): Ev => ({ seq, id: `id-${seq}` });
const range = (from: number, to: number): Ev[] => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

/** REST fake over a fixture log (append-only, seq-ordered, may have holes). */
function restLog(rows: Ev[]) {
    return {
        rows,
        calls: 0,
        failNext: 0,
        fetchPage: async function (after: number, limit: number): Promise<Ev[]> {
            this.calls += 1;
            if (this.failNext > 0) { this.failNext -= 1; throw new Error('REST down'); }
            return this.rows.filter(r => r.seq > after).slice(0, limit);
        },
    };
}

function harness(rows: Ev[], opts: { maxRetries?: number } = {}) {
    const log = restLog(rows);
    const emitted: Ev[] = [];
    let exhausted = 0;
    const cursor = new RoomCursor<Ev>({
        fetchPage: (a, l) => log.fetchPage(a, l),
        emit: es => emitted.push(...es),
        onExhausted: () => { exhausted += 1; },
        retryDelay: async () => {},
        maxRetries: opts.maxRetries ?? 5,
    });
    return { log, emitted, cursor, exhaustedCount: () => exhausted };
}

function assertNoSkips(emitted: Ev[], expectRows: Ev[]) {
    expect(emitted.map(e => e.seq)).toEqual(expectRows.map(e => e.seq)); // exact order, no skips, no dups
}

describe('v8 slice 1 — room cursor state machine', () => {
    it('(a) backlog > 500 paginates to the tail', async () => {
        const rows = range(1, 1200);
        const h = harness(rows);
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, rows);
        expect(h.cursor.cursor).toBe(1200);
        expect(h.log.calls).toBeGreaterThanOrEqual(3);
    });

    it('(b) partial page + live event beyond it: the gap is fetched before any merge', async () => {
        const h = harness(range(1, 100));
        // catch-up starts against 100 persisted rows; DURING it, rows 101-105
        // land in the log and 105 arrives live.
        const origFetch = h.log.fetchPage.bind(h.log);
        let firstCall = true;
        h.log.fetchPage = async function (after: number, limit: number) {
            const page = await origFetch(after, limit);
            if (firstCall) {
                firstCall = false;
                this.rows.push(...range(101, 105));  // persisted after the first read
                h.cursor.onLive(ev(105));            // live jumps ahead mid-catch-up
            }
            return page;
        };
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, range(1, 105));     // 101-104 fetched, nothing skipped
        expect(h.cursor.cursor).toBe(105);
        expect(h.cursor.pendingBufferSize()).toBe(0);
    });

    it('(c) fetch failure then a HIGHER live event: no advancement across the gap, retry recovers all', async () => {
        const rows = range(1, 50);
        const h = harness(rows);
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, rows);
        // REST goes down; rows 51-60 persist meanwhile; live 60 arrives.
        h.log.failNext = 2;
        h.log.rows.push(...range(51, 60));
        h.cursor.onLive(ev(60));                     // must BUFFER, not advance
        await h.cursor.catchUp();                    // retries through the failures
        assertNoSkips(h.emitted, range(1, 60));      // 51-59 delivered before 60, in order
        expect(h.cursor.cursor).toBe(60);
    });

    it('(c2) retries exhausted: buffer preserved, cursor frozen, onExhausted fires; recovery resumes cleanly', async () => {
        const h = harness(range(1, 10), { maxRetries: 1 });
        await h.cursor.catchUp();
        h.log.failNext = 99;                         // hard outage
        h.log.rows.push(...range(11, 20));
        h.cursor.onLive(ev(20));
        await h.cursor.catchUp();
        expect(h.exhaustedCount()).toBeGreaterThanOrEqual(1);
        expect(h.cursor.cursor).toBe(10);            // frozen — never advanced across the gap
        expect(h.cursor.pendingBufferSize()).toBe(1);
        h.log.failNext = 0;                          // REST recovers (e.g. forced reconnect → onopen)
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, range(1, 20));
        expect(h.cursor.cursor).toBe(20);
    });

    it('live events advance directly ONLY on exactly-next seq', async () => {
        const h = harness(range(1, 3));
        await h.cursor.catchUp();
        h.cursor.onLive(ev(4));                      // exactly next: direct
        expect(h.cursor.cursor).toBe(4);
        h.log.rows.push(ev(4), ev(5), ev(6), ev(7));
        h.cursor.onLive(ev(7));                      // jump: buffers + catch-up resolves 5-6 first
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, [...range(1, 7)]);
        expect(h.cursor.cursor).toBe(7);
    });

    it('seq holes (aborted inserts) do not deadlock: the fetch is the authority', async () => {
        const rows = [ev(1), ev(2), ev(5), ev(6)];   // 3-4 consumed by aborted inserts
        const h = harness(rows);
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, rows);
        expect(h.cursor.cursor).toBe(6);
        // live jump across a hole: 8 arrives while 8 is the next real row
        h.log.rows.push(ev(8));
        h.cursor.onLive(ev(8));                      // seq 7 is a hole — buffered, fetch resolves
        await h.cursor.catchUp();
        expect(h.cursor.cursor).toBe(8);
        assertNoSkips(h.emitted, [ev(1), ev(2), ev(5), ev(6), ev(8)]);
    });

    it('duplicates (live+fetched overlap) are delivered exactly once', async () => {
        const h = harness(range(1, 5));
        await h.cursor.catchUp();
        h.cursor.onLive(ev(5));                      // dup of fetched row
        h.cursor.onLive(ev(6));                      // direct
        h.log.rows.push(ev(6));
        await h.cursor.catchUp();
        assertNoSkips(h.emitted, range(1, 6));
    });
});
