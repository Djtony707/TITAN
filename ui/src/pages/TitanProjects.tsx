import { FolderKanban } from 'lucide-react';
import { Link } from 'react-router';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Projects — placeholder
   ═══════════════════════════════════════════════════════════════════

   v6.1.0-beta.23 — gutted to a placeholder. The previous implementation
   fabricated project metadata: `issueCount`, `agentCount`, and
   `progress` were all `Math.random()`; `status` was assigned by `i % 3`.
   Sessions data was real but the project shape it produced was a lie.
   Tony's mock-data audit (2026-05-17) flagged this as a top offender
   because the progress bars and counts looked authoritative.

   The page is currently orphaned — App.tsx redirects /projects to
   /space/home, and the only sidebar that pointed here (TitanSidebar) was
   marked @deprecated in beta.22. A real Projects view will land in v6.2
   once "project" is a first-class concept in TITAN's data model
   (today there's no project table — only sessions, goals, and missions).

   Until then this file stays as a deliberately empty placeholder so
   nothing can accidentally route to a page that ships fake metrics.
*/

export function TitanProjects() {
  return (
    <div className="h-full overflow-auto p-4 md:p-6 flex items-center justify-center">
      <div className="text-center max-w-md">
        <FolderKanban className="w-10 h-10 text-[#3f3f46] mx-auto mb-3" />
        <h1 className="text-lg font-semibold text-[#fafafa] mb-2">Projects</h1>
        <p className="text-sm text-[#a1a1aa] mb-4">
          A real Projects view is coming. Until then there is no project domain
          in TITAN&apos;s data model — only sessions, goals, and missions.
        </p>
        <Link
          to="/command-post/goals"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-xs hover:bg-[#6366f1]/20 transition-colors"
        >
          Go to Goals
        </Link>
      </div>
    </div>
  );
}
