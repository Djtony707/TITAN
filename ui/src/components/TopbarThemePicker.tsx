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
import { useLocation } from 'react-router';
import { useThemeName, type ThemeName } from '@/hooks/useThemeVariables';

interface Props {
    /** Optional className to nudge position / z-index per host page. */
    className?: string;
}

const OPTIONS: { value: ThemeName; label: string }[] = [
    { value: 'studio',       label: 'Studio' },
    { value: 'office',       label: 'Office' },
    { value: 'night',        label: 'Night Desk' },
    { value: 'workshop',     label: 'Workshop' },
    { value: 'observatory',  label: 'Observatory' },
];

export function TopbarThemePicker({ className = '' }: Props) {
    const { theme, setTheme } = useThemeName();
    const location = useLocation();
    const avoidsCommandPostAgentsRail = location.pathname.startsWith('/command-post');
    const rightOffset = avoidsCommandPostAgentsRail
        ? 'calc(var(--titan-agents-rail-width, 16rem) + 0.75rem)'
        : '0.75rem';

    return (
        <>
            <style>{`
                @media (max-width: 640px) {
                    .titan-theme-picker {
                        top: 12px !important;
                        right: 12px !important;
                        bottom: auto !important;
                        left: auto !important;
                        transform: none;
                        max-width: calc(100vw - 24px);
                    }
                    .titan-theme-picker button {
                        padding-left: 10px !important;
                        padding-right: 10px !important;
                    }
                }
            `}</style>
            <div
                role="tablist"
                aria-label="Visual theme"
                // v6.1.0-beta.3 — desktop sits at top: 48 (BELOW the existing
                // per-page chrome row). Mobile moves to bottom-center because
                // top page headers have less vertical breathing room.
                // v6.1.0-beta.25 hotfix — /command-post mounts the live AGENTS
                // rail on the right; keep the picker out of that 16rem lane.
                className={`titan-theme-picker fixed z-50 flex gap-0 rounded-full p-0.5 ${className}`}
                style={{
                    top: 48,
                    right: rightOffset,
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
        </>
    );
}
