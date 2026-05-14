/**
 * TITAN — Sponsor footer (v6.1.0-alpha.21)
 *
 * A tasteful, low-opacity sponsor link mounted at the bottom of each
 * canvas / chat / desk surface. The goal Tony stated: visible enough
 * that supporters who already want to back the project see it on
 * every page, but **muted enough that it never reads as begging**.
 *
 * Design choices:
 *   - Default opacity 0.5, brightens to 0.95 on hover. Reads as a
 *     gentle reminder, not a call-to-action.
 *   - Text-[11px], single line, no border, no background.
 *   - A small pink heart with a subtle pulse so the eye finds it
 *     when the user is already looking for it.
 *   - Opens https://github.com/sponsors/Djtony707 in a new tab so
 *     the user never loses their TITAN context.
 *   - Theming via the optional `tone` prop:
 *       'dark'  — default, soft white text. For dark backgrounds
 *                 (Mission Chat, Mission Library, app shell).
 *       'wood'  — caramel text. For the Mission Canvas wood desk.
 *       'light' — soft gray text. For light backgrounds.
 *
 * Place it inside an existing footer rail or pin it to the bottom of
 * a page. Don't double it up — one per visible surface.
 */
import React from 'react';

const SPONSOR_URL = 'https://github.com/sponsors/Djtony707';

export function SponsorFooter({
  tone = 'dark',
  className = '',
}: {
  tone?: 'dark' | 'wood' | 'light';
  className?: string;
}) {
  const palette =
    tone === 'wood'
      ? { text: '#d9c08c', heart: '#ff7ab6' }
      : tone === 'light'
      ? { text: '#6b6b6b', heart: '#ec4899' }
      : { text: '#a1a1aa', heart: '#ec4899' };

  return (
    <a
      href={SPONSOR_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="If TITAN saves you time, a small monthly sponsorship keeps it open-source — thank you."
      className={`inline-flex items-center gap-1.5 text-[11px] opacity-50 hover:opacity-95 transition-opacity tracking-wide ${className}`}
      style={{ color: palette.text, textDecoration: 'none' }}
    >
      <span style={{ color: palette.heart, animation: 'sponsorPulse 2.6s ease-in-out infinite' }} aria-hidden>
        ♥
      </span>
      <span>Built by Tony Elliott · Sponsor on GitHub</span>
      <span aria-hidden style={{ opacity: 0.6 }}>→</span>
      <style>{`@keyframes sponsorPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }`}</style>
    </a>
  );
}
