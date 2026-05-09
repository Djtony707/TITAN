/**
 * SSE flush helper — disables TCP Nagle and flushes after every write.
 * Without this, Node.js/Express buffers SSE events (up to 16 KB) causing
 * the UI to hang until the buffer fills or the response ends.
 *
 * Usage:
 *   const sseWrite = setupSSEFlush(res);
 *   sseWrite(`data: ${JSON.stringify(chunk)}\n\n`);
 */
import type { Response } from 'express';

export function setupSSEFlush(res: Response): (data: string) => void {
    // Disable Nagle's algorithm so small packets are sent immediately
    // (res.socket is typed narrowly; cast to any for setNoDelay)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sock = (res as any).socket;
    if (sock && typeof sock.setNoDelay === 'function') {
        sock.setNoDelay(true);
    }
    return (data: string) => {
        res.write(data);
        // Express compression middleware monkey-patches res.flush;
        // call it when present to push data through immediately.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof (res as any).flush === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (res as any).flush();
        }
    };
}
