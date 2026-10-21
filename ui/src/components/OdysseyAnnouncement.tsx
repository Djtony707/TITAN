import { useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';

export function OdysseyAnnouncement() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  // Leave room for the existing fixed theme picker and Soma control.
  return (
    <aside
      aria-label="Odyssey announcement"
      className="mx-4 mb-4 mt-24 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[var(--text)] md:mt-40"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">TITAN is evolving into Odyssey</p>
          <p className="mt-1 text-sm">
            The next generation of TITAN is in development. Local models remain part of the plan.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a
              href="https://lakelogicai.net/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-8 items-center gap-1 rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              Explore Odyssey <ArrowUpRight size={14} aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a
              href="https://lakelogicai.net/#beta"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-8 items-center gap-1 rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              Register beta interest <ArrowUpRight size={14} aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss Odyssey announcement"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-tertiary)] focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
