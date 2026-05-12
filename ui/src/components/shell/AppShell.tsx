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
        {/* v6.0 step 2 — On Space routes, show the Spaces sidebar (canvas-as-
            homepage shell). On admin routes, the legacy IconRail still drives
            the 7 fixed pages. */}
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
