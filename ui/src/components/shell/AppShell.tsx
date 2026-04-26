import { Outlet, useLocation } from 'react-router';
import IconRail from './IconRail';
import StatusBar from './StatusBar';
import { MobileNav } from './MobileNav';

export default function AppShell() {
  const location = useLocation();
  const isSpaceRoute = location.pathname === '/' || location.pathname === '/space';

  return (
    <div className={`flex flex-col h-screen overflow-hidden ${isSpaceRoute ? 'bg-[#050816]' : 'bg-bg'}`}>
      {!isSpaceRoute && <MobileNav />}
      <div className="flex flex-1 min-h-0 relative">
        {!isSpaceRoute && (
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
