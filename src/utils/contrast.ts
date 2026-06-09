/**
 * TITAN — WCAG 2.1 contrast math (v7.0 accessibility).
 *
 * Pure, dependency-free implementation of the WCAG relative-luminance and
 * contrast-ratio formulas. Used by the theme contrast-audit test (and available
 * at runtime for any "is this color pair legible?" check) so TITAN's themes are
 * verified to meet AA programmatically instead of by eyeballing.
 *
 * Spec: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 *   - AA  normal text  : ≥ 4.5:1
 *   - AA  large text   : ≥ 3.0:1   (≥18.66px bold or ≥24px)
 *   - AA  UI component : ≥ 3.0:1   (borders, icons, focus rings)
 */

export interface Rgb { r: number; g: number; b: number }

/** Parse `#rgb` / `#rrggbb` to 0–255 channels. Throws on anything else. */
export function hexToRgb(hex: string): Rgb {
    const h = hex.trim().replace(/^#/, '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex color: "${hex}"`);
    return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
    };
}

/** Parse `rgba(r,g,b,a)` / `rgb(r,g,b)` → { rgb, a }. Throws on anything else. */
export function parseRgba(s: string): { rgb: Rgb; a: number } {
    const m = s.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/);
    if (!m) throw new Error(`Not an rgb(a) color: "${s}"`);
    return {
        rgb: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
        a: m[4] === undefined ? 1 : Number(m[4]),
    };
}

/**
 * Composite a (possibly translucent) color over an opaque base, returning the
 * resulting opaque color. Accepts hex or rgb(a) strings for `fg`; `base` must be
 * opaque hex. Needed because some theme surfaces are rgba over the page bg.
 */
export function flatten(fg: string, base: string): Rgb {
    const b = hexToRgb(base);
    let fgRgb: Rgb; let a = 1;
    if (fg.trim().startsWith('#')) {
        fgRgb = hexToRgb(fg);
    } else {
        const p = parseRgba(fg);
        fgRgb = p.rgb; a = p.a;
    }
    return {
        r: Math.round(fgRgb.r * a + b.r * (1 - a)),
        g: Math.round(fgRgb.g * a + b.g * (1 - a)),
        b: Math.round(fgRgb.b * a + b.b * (1 - a)),
    };
}

/** WCAG relative luminance (0=black … 1=white). */
export function relativeLuminance(c: Rgb): number {
    const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG contrast ratio between two colors (1:1 … 21:1). Each color may be hex,
 * rgb(a), or an already-parsed Rgb. Translucent inputs are flattened over
 * `base` (default white) first.
 */
export function contrastRatio(a: string | Rgb, b: string | Rgb, base = '#ffffff'): number {
    const toRgb = (x: string | Rgb): Rgb => {
        if (typeof x !== 'string') return x;
        return x.trim().startsWith('#') ? hexToRgb(x) : flatten(x, base);
    };
    const l1 = relativeLuminance(toRgb(a));
    const l2 = relativeLuminance(toRgb(b));
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
}

/** True when the pair meets AA. `level`: 'text' (4.5:1) or 'large'|'ui' (3:1). */
export function meetsAA(ratio: number, level: 'text' | 'large' | 'ui' = 'text'): boolean {
    return ratio >= (level === 'text' ? 4.5 : 3.0);
}

/** Round to 2 dp for readable reporting. */
export function ratioStr(ratio: number): string {
    return `${Math.round(ratio * 100) / 100}:1`;
}
