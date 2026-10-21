import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { wrapHtmlForViewer } from '../ui/src/pages/mission/htmlSanitize.js';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });
function documentFor(content: string) {
    dom = new JSDOM('', { url: 'http://127.0.0.1/' });
    vi.stubGlobal('window', dom.window);
    return new JSDOM(wrapHtmlForViewer(content)).window.document;
}

describe('inert report HTML', () => {
    it('keeps the dormant widget preview export inert with no iframe, source evaluation or network', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const { createElement } = await import('../ui/node_modules/react/index.js');
        const { renderToStaticMarkup } = await import('../ui/node_modules/react-dom/server.node.js');
        const { WidgetSandbox } = await import('../ui/src/space-agent/WidgetSandbox.js');
        const markup = renderToStaticMarkup(createElement(WidgetSandbox, { widget: {
            id: 'fixture', title: 'Held fixture', code: 'SHOULD_NOT_EVALUATE',
        }, onRemove: vi.fn() }));
        expect(markup).toContain('security hold');
        expect(markup).not.toContain('<iframe');
        expect(markup).not.toContain('SHOULD_NOT_EVALUATE');
        expect(markup).not.toContain('unpkg.com');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('renders the actual viewer as an iframe without script or same-origin sandbox permission', async () => {
        dom = new JSDOM('', { url: 'http://127.0.0.1/' });
        vi.stubGlobal('window', dom.window);
        const { createElement } = await import('../ui/node_modules/react/index.js');
        const { renderToStaticMarkup } = await import('../ui/node_modules/react-dom/server.node.js');
        const { FileViewer } = await import('../ui/src/pages/mission/FileViewer.js');
        const markup = renderToStaticMarkup(createElement(FileViewer, { state: { ref: 'fixture.html', loading: false,
            file: { ref: 'fixture.html', content: '<h1>fixture</h1>', mimeType: 'text/html', encoding: 'utf-8', sizeBytes: 16, truncated: false },
        }, onClose() {} }));
        const doc = new JSDOM(markup).window.document;
        const frame = doc.querySelector('iframe[title="HTML report preview"]');
        expect(frame?.getAttribute('sandbox')).toBe('');
        expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(frame?.getAttribute('srcdoc')).toContain("script-src 'none'");
    });

    it('removes embedded documents, encoded navigation and active elements using a DOM sanitizer', () => {
        const doc = documentFor('<iframe srcdoc="&lt;script&gt;parent.fixtureCompromised=true&lt;/script&gt;"></iframe><object data="data:text/html,fixture"></object><meta http-equiv="refresh" content="0;url=https://example.invalid"><base href="https://example.invalid"><form action="/api/message"><input value="fixture"></form>');
        expect(doc.querySelector('iframe,object,embed,form,input,base,meta[http-equiv="refresh"]')).toBeNull();
        expect(doc.documentElement.outerHTML).not.toContain('fixtureCompromised');
    });

    it.each(['javascript:fixture()', 'java&#x73;cript:fixture()', '&#x6a;avascript:fixture()'])('removes unquoted/encoded active URL %s', (url) => {
        const doc = documentFor(`<a href=${url}>fixture link</a><img src=x onerror=fixture()>`);
        expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
        expect(doc.querySelector('[onerror]')).toBeNull();
    });

    it('places restrictive policy before preserved styled report content and data images', () => {
        const doc = documentFor('<html><head><style>h1{color:red}</style></head><body><h1>Report fixture</h1><table><tr><td>42</td></tr></table><img alt="chart" src="data:image/png;base64,AA=="></body></html>');
        const csp = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'none'");
        expect(csp).toContain("frame-src 'none'");
        expect(csp).toContain("form-action 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(doc.querySelector('h1')?.textContent).toBe('Report fixture');
        expect(doc.querySelector('td')?.textContent).toBe('42');
        expect(Array.from(doc.querySelectorAll('style')).map(style => style.textContent).join('')).toContain('color:red');
        expect(doc.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    });

    it('keeps external-image placeholders without remote loads or markup injection', () => {
        const doc = documentFor('<img src="https://example.invalid/image.png" alt="&lt;fixture&gt;"><p>kept</p>');
        expect(doc.querySelector('img')).toBeNull();
        expect(doc.querySelector('figcaption')?.textContent).toBe('<fixture>');
        expect(doc.querySelector('p')?.textContent).toBe('kept');
    });
});
