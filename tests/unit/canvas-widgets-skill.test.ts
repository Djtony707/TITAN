/**
 * canvas_widgets skill — unit tests.
 *
 * Pins:
 *   - Envelope resolution from `template:` uses the gallery and inherits
 *     defaultSize.
 *   - Envelope resolution from raw `source:` works without a template.
 *   - Missing-required-input → returns a self-describing `Error: ...`
 *     string (silent-on-success / loud-on-failure).
 *   - Size clamping at 1..12.
 *   - System-widget templates (source === "system:xxx") force format=system.
 *
 * The full create_widget execute() path is covered indirectly via these
 * unit checks; end-to-end SSE delivery is exercised by the deploy smoke
 * probe on Titan PC.
 */
import { describe, it, expect } from 'vitest';
import { __test__ } from '../../src/skills/builtin/canvas_widgets.js';

const {
    resolveEnvelope,
    clamp,
    detectBlockedIframeHost,
    normalizeFormat,
    normalizeName,
    extractMetaDims,
    extractComponentName,
} = __test__;

describe('canvas_widgets — clamp', () => {
    it('falls back to default when input is missing/non-numeric', () => {
        expect(clamp(undefined, 4, 12)).toBe(4);
        expect(clamp('x' as unknown, 4, 12)).toBe(4);
        expect(clamp(NaN, 4, 12)).toBe(4);
    });
    it('clamps below 1 up to 1', () => {
        expect(clamp(0, 4, 12)).toBe(1);
        expect(clamp(-3, 4, 12)).toBe(1);
    });
    it('clamps above max down to max', () => {
        expect(clamp(99, 4, 12)).toBe(12);
    });
    it('passes through values in range, flooring fractions', () => {
        expect(clamp(5, 4, 12)).toBe(5);
        expect(clamp(7.8, 4, 12)).toBe(7);
    });
});

describe('canvas_widgets — resolveEnvelope (raw source)', () => {
    it('builds a react envelope from raw source + name', () => {
        const e = resolveEnvelope({
            name: 'Hello',
            source: 'export default () => <div>hi</div>',
        });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.name).toBe('Hello');
        expect(e.format).toBe('react');
        expect(e.w).toBe(4);
        expect(e.h).toBe(4);
        expect(e.title).toBe('Hello'); // defaults to name
    });

    it('honors explicit w/h and clamps to [1, 12]', () => {
        const e = resolveEnvelope({
            name: 'Big',
            source: 'x',
            w: 99,
            h: 0.5,
        });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.w).toBe(12); // clamped up to max
        expect(e.h).toBe(1);  // clamped up from 0/<1
    });

    it('synthesizes a name from source when name is missing', () => {
        const e = resolveEnvelope({
            source: '// MyWidget\nexport default () => null',
        });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.name).toBeTruthy();
        expect(e.name.length).toBeLessThanOrEqual(40);
    });

    it('returns Error string when neither template nor source is given', () => {
        const e = resolveEnvelope({ name: 'X' });
        expect(typeof e).toBe('string');
        expect(e as string).toMatch(/^Error:/);
        expect(e as string).toMatch(/template.*source/i);
    });
});

describe('canvas_widgets — resolveEnvelope (gallery template)', () => {
    it('returns Error string for an unknown template id', () => {
        const e = resolveEnvelope({ template: '__does-not-exist__' });
        expect(typeof e).toBe('string');
        expect(e as string).toMatch(/^Error:/);
        expect(e as string).toMatch(/not found/i);
    });

    it('resolves a known system template + flips format to "system"', () => {
        // system-training is hardcoded in widget_gallery.ts as
        // `source: "system:training"` — touching it confirms the system-
        // widget pathway works end-to-end.
        const e = resolveEnvelope({ template: 'system-training' });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.format).toBe('system');
        expect(e.source).toBe('system:training');
        // defaultSize from the template should flow through.
        expect(e.w).toBeGreaterThanOrEqual(1);
        expect(e.h).toBeGreaterThanOrEqual(1);
        expect(e.metadata?.templateId).toBe('system-training');
    });

    it('caller w/h overrides override the template defaultSize', () => {
        const e = resolveEnvelope({ template: 'system-training', w: 8, h: 3 });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.w).toBe(8);
        expect(e.h).toBe(3);
    });
});

describe('canvas_widgets — resolveEnvelope (x/y placement)', () => {
    it('omits x/y when not provided so the canvas auto-places', () => {
        const e = resolveEnvelope({ source: 'x', name: 'X' });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.x).toBeUndefined();
        expect(e.y).toBeUndefined();
    });

    it('passes through explicit x/y', () => {
        const e = resolveEnvelope({ source: 'x', name: 'X', x: 2, y: 5 });
        if (typeof e === 'string') throw new Error(`unexpected error: ${e}`);
        expect(e.x).toBe(2);
        expect(e.y).toBe(5);
    });
});

// ─── v6.0 reliability hardening — input normalization ──────────────

describe('canvas_widgets v6.0 — normalizeFormat', () => {
    it('coerces jsx / tsx / javascript / js → react', () => {
        expect(normalizeFormat('jsx')).toBe('react');
        expect(normalizeFormat('tsx')).toBe('react');
        expect(normalizeFormat('javascript')).toBe('react');
        expect(normalizeFormat('js')).toBe('react');
    });
    it('preserves valid formats unchanged', () => {
        expect(normalizeFormat('react')).toBe('react');
        expect(normalizeFormat('vanilla')).toBe('vanilla');
        expect(normalizeFormat('html')).toBe('html');
        expect(normalizeFormat('iframe')).toBe('iframe');
        expect(normalizeFormat('system')).toBe('system');
    });
    it('is case-insensitive', () => {
        expect(normalizeFormat('REACT')).toBe('react');
        expect(normalizeFormat('JsX')).toBe('react');
    });
    it('defaults to react on unknown / non-string', () => {
        expect(normalizeFormat('mystery')).toBe('react');
        expect(normalizeFormat(undefined)).toBe('react');
        expect(normalizeFormat(42)).toBe('react');
    });
});

describe('canvas_widgets v6.0 — normalizeName', () => {
    it('strips the __WIDGET_META__ comment that models leak as name', () => {
        expect(normalizeName('__WIDGET_META__ w=6 h=6')).toBe('');
    });
    it('strips leading comment markers + caps at 60 chars', () => {
        expect(normalizeName('// Clock')).toBe('Clock');
        expect(normalizeName('/* Big Widget */')).toBe('Big Widget');
        const long = 'x'.repeat(100);
        expect(normalizeName(long).length).toBeLessThanOrEqual(60);
    });
    it('passes through clean names', () => {
        expect(normalizeName('Pomodoro Timer')).toBe('Pomodoro Timer');
    });
});

describe('canvas_widgets v6.0 — extractMetaDims', () => {
    it('parses `// __WIDGET_META__ w=N h=M` headers the canvas uses', () => {
        const r = extractMetaDims('// __WIDGET_META__ w=8 h=4\nexport default () => null');
        expect(r.w).toBe(8);
        expect(r.h).toBe(4);
    });
    it('returns empty when no meta comment', () => {
        expect(extractMetaDims('export default () => null')).toEqual({});
    });
    it('tolerates extra spaces in the comment', () => {
        const r = extractMetaDims('//   __WIDGET_META__   w = 6   h = 3');
        expect(r.w).toBe(6);
        expect(r.h).toBe(3);
    });
});

describe('canvas_widgets v6.0 — extractComponentName', () => {
    it('finds `function Foo` style React components', () => {
        expect(extractComponentName('function Clock() { return <div/>; }')).toBe('Clock');
    });
    it('finds `const Foo = (...) =>` style', () => {
        expect(extractComponentName('const PomodoroTimer = () => <div/>;')).toBe('PomodoroTimer');
    });
    it('finds `export default function Foo`', () => {
        expect(extractComponentName('export default function MyWidget() { return null }')).toBe('MyWidget');
    });
    it('returns null when no capitalized component is present', () => {
        expect(extractComponentName('const foo = 1;')).toBe(null);
    });
});

// ─── v6.0 — Blocked-iframe pre-flight (eBay/Google failure prevention) ──

describe('canvas_widgets v6.0 — detectBlockedIframeHost', () => {
    it('flags <iframe src="https://www.ebay.com/..."> (the failure that started this)', () => {
        const src = '<iframe src="https://www.ebay.com/search?q=laptop" />';
        expect(detectBlockedIframeHost(src)).toMatch(/ebay\.com/);
    });
    it('flags Google embedding attempts', () => {
        expect(detectBlockedIframeHost('<iframe src="https://www.google.com">')).toMatch(/google\.com/);
        expect(detectBlockedIframeHost('<iframe src=\'https://google.com\'>')).toMatch(/google\.com/);
    });
    it('flags YouTube + Facebook + LinkedIn + a few common others', () => {
        expect(detectBlockedIframeHost('<iframe src="https://youtube.com/watch?v=x">')).toBeTruthy();
        expect(detectBlockedIframeHost('<iframe src="https://www.facebook.com">')).toBeTruthy();
        expect(detectBlockedIframeHost('<iframe src="https://www.linkedin.com/feed">')).toBeTruthy();
    });
    it('flags subdomains of blocked hosts (mail.google.com, docs.google.com)', () => {
        expect(detectBlockedIframeHost('<iframe src="https://mail.google.com/inbox">')).toBeTruthy();
        expect(detectBlockedIframeHost('<iframe src="https://docs.google.com/document/d/x">')).toBeTruthy();
    });
    it('does NOT flag same-origin/relative iframe srcs (those route via the gateway)', () => {
        expect(detectBlockedIframeHost('<iframe src="/api/proxy?url=...">')).toBe(null);
        expect(detectBlockedIframeHost('<iframe src="#section">')).toBe(null);
    });
    it('does NOT flag friendly embed-allowing hosts', () => {
        expect(detectBlockedIframeHost('<iframe src="https://example.com">')).toBe(null);
        expect(detectBlockedIframeHost('<iframe src="https://en.wikipedia.org/wiki/Main_Page">')).toBe(null);
        expect(detectBlockedIframeHost('<iframe src="https://www.openstreetmap.org/export/embed.html">')).toBe(null);
    });
    it('returns null when there is no iframe at all', () => {
        expect(detectBlockedIframeHost('export default () => <div>hi</div>')).toBe(null);
    });
    it('handles malformed iframe URLs without throwing', () => {
        expect(detectBlockedIframeHost('<iframe src="not a url">')).toBe(null);
    });
});

describe('canvas_widgets v6.0 — resolveEnvelope rejects blocked iframes early', () => {
    it('eBay iframe source → returns an actionable Error string (NOT a successful envelope)', () => {
        const r = resolveEnvelope({
            name: 'eBay',
            source: 'export default () => <iframe src="https://www.ebay.com" />',
        });
        expect(typeof r).toBe('string');
        const err = r as string;
        expect(err).toMatch(/^Error:/);
        expect(err.toLowerCase()).toMatch(/x-frame-options|csp|frame-ancestors|blocks embedding/);
        // The error must surface the alternatives so the agent retries correctly.
        expect(err).toMatch(/api\/proxy/);
        expect(err).toMatch(/browser_screenshot/);
        expect(err).toMatch(/new tab|target="_blank"/);
    });

    it('Google search iframe source → also rejected with same guidance', () => {
        const r = resolveEnvelope({
            name: 'Google Search',
            source: '<iframe src="https://www.google.com/search?q=foo" />',
        });
        expect(typeof r).toBe('string');
        expect(r as string).toMatch(/^Error:/);
    });

    it('Wikipedia iframe → allowed (Wikipedia permits embedding)', () => {
        const r = resolveEnvelope({
            name: 'Wiki',
            source: '<iframe src="https://en.wikipedia.org/wiki/Main_Page" />',
        });
        // Should be a valid envelope, not an error.
        expect(typeof r).not.toBe('string');
    });
});
