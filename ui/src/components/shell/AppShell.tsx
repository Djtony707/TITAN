/**
 * @deprecated 2026-05-17 (v6.1.0-beta.22)
 *
 * AppShell, IconRail, MobileNav, TitanSidebar, and TitanLayout are stale
 * navigation shells that are NOT rendered from App.tsx. The live sidebars
 * are SpacesSidebar (canvas, mounted inside TitanCanvas) and CPSidebar
 * (Command Post, mounted inside CPLayout).
 *
 * They survived because nothing imports them at the top level, but their
 * presence creates IA confusion — devs assume there's a global app shell
 * with a unified sidebar. There isn't.
 *
 * Hard-deletion deferred to beta.24 (one beta soak). Do NOT add new
 * imports. See `~/Desktop/TitanBot/TITAN-main/CHANGELOG.md` v6.1.0-beta.22
 * for the IA-redesign plan that supersedes this shell.
 */
import { Outlet, useLocation } from 'react-router';
import IconRail from './IconRail';
import StatusBar from './StatusBar';
import { MobileNav } from './MobileNav';
import { SpacesSidebar } from './SpacesSidebar';
export default function AppShell() {
  const location = useLocation();
  // v6.0 step 2 — "Space routes" include /space, /space/:id, and the root path
  // (which Mission Control treats as the default canvas).
  const isSpaceRoute =
    location.pathname === '/' ||
    location.pathname === '/space' ||
    location.pathname.startsWith('/space/');

  return (
    <div className={`flex flex-col h-screen overflow-hidden ${isSpaceRoute ? 'bg-[#050816]' : 'bg-bg'}`}>
      {!isSpaceRoute && <MobileNav />}
      <div className="flex flex-1 min-h-0 relative">
        {isSpaceRoute ? (
          <div className="hidden md:block">
            <SpacesSidebar />
          </div>
        ) : (
          <div className="hidden md:block">
            <IconRail />
          </div>
        )}
        <main className="flex-1 min-w-0 overflow-hidden relative">
          <Outlet />
        </main>
      </div>
      {!isSpaceRoute && <StatusBar />}

    </div>
  );
}
