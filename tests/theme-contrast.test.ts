import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { contrastRatio, meetsAA, ratioStr, hexToRgb } from '../src/utils/contrast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '..', 'ui', 'src', 'styles', 'theme-variables.css'), 'utf-8');

/** Extract every `:root[data-theme='X'] { … }` block → { theme: { token: value } }. */
function parseThemes(css: string): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    const blockRe = /:root\[data-theme=['"]([\w-]+)['"]\]\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(css)) !== null) {
        const [, theme, body] = m;
        const tokens: Record<string, string> = {};
        const varRe = /(--theme-[\w-]+)\s*:\s*([^;]+);/g;
        let v: RegExpExecArray | null;
        while ((v = varRe.exec(body)) !== null) tokens[v[1].trim()] = v[2].trim();
        out[theme] = tokens;
    }
    return out;
}

const THEMES = parseThemes(CSS);
const themeNames = Object.keys(THEMES);

describe('contrast math (WCAG 2.1)', () => {
    it('black vs white is the maximum 21:1', () => {
        expect(Math.round(contrastRatio('#000000', '#ffffff'))).toBe(21);
    });
    it('identical colors are 1:1', () => {
        expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    });
    it('parses shorthand hex', () => {
        expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    });
    it('flattens translucent foreground over a base before measuring', () => {
        // fully-transparent fg over white → measures as white-on-white = 1:1
        expect(contrastRatio('rgba(0,0,0,0)', '#ffffff')).toBeCloseTo(1, 5);
    });
    it('meetsAA thresholds', () => {
        expect(meetsAA(4.5, 'text')).toBe(true);
        expect(meetsAA(4.49, 'text')).toBe(false);
        expect(meetsAA(3.0, 'ui')).toBe(true);
        expect(meetsAA(2.99, 'ui')).toBe(false);
    });
});

describe('theme palettes parse', () => {
    it('finds all theme blocks', () => {
        expect(themeNames).toEqual(expect.arrayContaining(['office', 'workshop', 'observatory']));
    });
    it('each theme defines the core tokens the audit needs', () => {
        for (const t of themeNames) {
            for (const tok of ['--theme-ink', '--theme-paper', '--theme-ink-soft', '--theme-bg-base', '--theme-menu-active-fg', '--theme-menu-active-bg']) {
                expect(THEMES[t][tok], `${t} missing ${tok}`).toBeDefined();
            }
        }
    });
});

/**
 * The critical legibility pairs every theme must satisfy. Each entry documents
 * WHAT renders against WHAT and the WCAG level that applies.
 *   - Primary body text (ink) on its reading surface (paper) → AA text 4.5:1.
 *   - Secondary/muted text (ink-soft) on the page surface (bg-base) → AA UI 3:1.
 *   - Active menu item text (menu-active-fg) on its fill (menu-active-bg) → AA text 4.5:1.
 * Surfaces may be rgba (e.g. observatory paper) → flattened over bg-base first.
 */
describe.each(themeNames)('theme "%s" meets WCAG AA on critical pairs', (theme) => {
    const tk = (name: string) => THEMES[theme][name];
    const bgBase = tk('--theme-bg-base');
    // bg-base itself can be hex (all current themes use hex here).
    const surfaceBase = bgBase.startsWith('#') ? bgBase : '#1a1235';

    it('primary text (ink on paper) ≥ 4.5:1', () => {
        const r = contrastRatio(tk('--theme-ink'), tk('--theme-paper'), surfaceBase);
        expect(meetsAA(r, 'text'), `${theme}: ink-on-paper = ${ratioStr(r)}`).toBe(true);
    });

    it('muted text (ink-soft on bg-base) ≥ 3:1', () => {
        const r = contrastRatio(tk('--theme-ink-soft'), surfaceBase, surfaceBase);
        expect(meetsAA(r, 'ui'), `${theme}: ink-soft-on-bg = ${ratioStr(r)}`).toBe(true);
    });

    it('active menu item (menu-active-fg on menu-active-bg) ≥ 4.5:1', () => {
        const r = contrastRatio(tk('--theme-menu-active-fg'), tk('--theme-menu-active-bg'), surfaceBase);
        expect(meetsAA(r, 'text'), `${theme}: menu-active = ${ratioStr(r)}`).toBe(true);
    });
});
