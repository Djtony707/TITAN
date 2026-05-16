/**
 * TITAN — Topbar Theme Picker (v6.1.0-beta.2 Phase 0b)
 *
 * Three-segment pill that switches the active theme between Office,
 * Workshop, and Observatory. Fixed top-right overlay so it's
 * accessible from every page without disturbing per-page layouts.
 *
 * Office  → wood desk + brass (current DeskSurface; default for /operations and most pages)
 * Workshop → brushed steel + blueprint + terminal green (engineering / dev shops)
 * Observatory → deep indigo + starfield + holo cyan (mission control; default for /mission)
 *
 * In Phase 0b only the CSS variables change (background + chrome
 * re-skin per `:root[data-theme=…]`). Workshop and Observatory base
 * surfaces (replacing the wood texture) land in Phase 0c.
 *
 * The picker reads + writes via `useThemeName()` which persists to
 * `localStorage['titan-theme-name']` and fires a `titan-theme-change`
 * event so the bridge hook in App re-attributes `<html>`.
 */
import React from 'react';
import { useThemeName, type ThemeName } from '@/hooks/useThemeVariables';

interface Props {
    /** Optional className to nudge position / z-index per host page. */
    className?: string;
}

const OPTIONS: { value: ThemeName; label: string }[] = [
    { value: 'office',       label: 'Office' },
    { value: 'workshop',     label: 'Workshop' },
    { value: 'observatory',  label: 'Observatory' },
];

export function TopbarThemePicker({ className = '' }: Props) {
    const { theme, setTheme } = useThemeName();
    return (
        <div
            role="tablist"
            aria-label="Visual theme"
            // v6.1.0-beta.3 — sits at top: 48 (BELOW the existing per-page
            // chrome row at top: 0-44) so it never covers page buttons.
            // Tony's first beta.2 placement at top: 3 collided with
            // /space/home's "v6.1.0 / Gallery / ⌘K / ⌘J" cluster and with
            // /mission/:id/canvas's "Tidy up / Chat view / Pause / Delete /
            // ?" cluster. Universal-empty position verified via Chrome MCP
            // bounding-box probe across all pages.
            className={`fixed right-3 z-50 flex gap-0 rounded-full p-0.5 ${className}`}
            style={{
                top: 48,
                background: 'var(--theme-menu-bg)',
                border: '1px solid var(--theme-menu-border)',
                fontFamily: 'var(--theme-font-display)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 6px 18px var(--theme-shadow)',
            }}
        >
            {OPTIONS.map((opt) => {
                const active = theme === opt.value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        role="tab"
                        aria-pressed={active}
                        onClick={() => setTheme(opt.value)}
                        style={{
                            border: 0,
                            cursor: 'pointer',
                            padding: '5px 12px',
                            fontSize: 11,
                            fontWeight: active ? 600 : 500,
                            color: active
                                ? 'var(--theme-menu-active-fg)'
                                : 'var(--theme-ink-soft)',
                            background: active
                                ? 'var(--theme-menu-active-bg)'
                                : 'transparent',
                            borderRadius: 999,
                            transition: 'background 180ms ease, color 180ms ease',
                            letterSpacing: '0.02em',
                            fontFamily: 'var(--theme-font-display)',
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
