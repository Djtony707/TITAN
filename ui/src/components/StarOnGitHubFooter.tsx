/**
 * TITAN — Star-on-GitHub footer (v6.3.3)
 *
 * Sibling to SponsorFooter. Sits in the same bottom-center pill so users
 * who want to support the project see both options on every page.
 *
 * Honest behavior (matches every other "Star on GitHub" button in OSS):
 *   - GitHub does NOT allow programmatically starring a repo on a user's
 *     behalf without OAuth + an explicit `public_repo` scope grant. So
 *     this button does NOT "star for you."
 *   - Click opens https://github.com/Djtony707/TITAN in a new tab where
 *     the user clicks the actual Star button themselves (~2 seconds if
 *     they're signed in).
 *   - Live star count is fetched once on mount (cached 15 min via
 *     localStorage) so users see "★ 27 Star on GitHub" rather than a
 *     stale or missing number. Falls through to just "★ Star on GitHub"
 *     when the API fails or rate-limits.
 *
 * Theming via `tone` mirrors SponsorFooter so both fit any background.
 */
import { useEffect, useState } from 'react';
import { fetchStarCount } from './githubStarCount';

const REPO_URL = 'https://github.com/Djtony707/TITAN';

export function StarOnGitHubFooter({
  tone = 'dark',
  className = '',
}: {
  tone?: 'dark' | 'wood' | 'light';
  className?: string;
}) {
  const palette =
    tone === 'wood'
      ? { text: '#d9c08c', star: '#ffd66e' }
      : tone === 'light'
      ? { text: '#6b6b6b', star: '#f59e0b' }
      : { text: '#a1a1aa', star: '#fbbf24' };

  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStarCount().then(count => {
      if (!cancelled) setStars(count);
    });
    return () => { cancelled = true; };
  }, []);

  // Pretty-format big numbers (e.g. 1234 → "1.2k") so the pill stays compact.
  const starLabel = stars === null
    ? 'Star on GitHub'
    : stars >= 1000
      ? `${(stars / 1000).toFixed(1).replace(/\.0$/, '')}k Star on GitHub`
      : `${stars} Star on GitHub`;

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Open TITAN on GitHub — click the Star button there to support the project (takes ~2 seconds if you're signed in)."
      className={`inline-flex items-center gap-1.5 text-[11px] opacity-50 hover:opacity-95 transition-opacity tracking-wide ${className}`}
      style={{ color: palette.text, textDecoration: 'none' }}
    >
      <span style={{ color: palette.star }} aria-hidden>
        ★
      </span>
      <span>{starLabel}</span>
      <span aria-hidden style={{ opacity: 0.6 }}>→</span>
    </a>
  );
}
