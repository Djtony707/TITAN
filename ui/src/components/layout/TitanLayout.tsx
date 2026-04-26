import { Outlet, useLocation, Link } from 'react-router';
import { useEffect, useMemo } from 'react';
import {
  ChevronRight, PanelRight, PanelRightClose, Command,
  Hexagon
} from 'lucide-react';
import { useSidebar } from '@/context/SidebarContext';
import { usePanel } from '@/context/PanelContext';
import { TitanSidebar } from './TitanSidebar';
import { PropertiesPanel } from './PropertiesPanel';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Layout — Main app shell modeled after Space Agent
   Sidebar + Breadcrumb + Main Content + Properties Panel
   ═══════════════════════════════════════════════════════════════════ */

const BREADCRUMB_MAP: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/space': 'Canvas',
  '/': 'Mission',
  '/command-post': 'Command Post',
  '/intelligence': 'Intelligence',
  '/tools': 'Tools',
  '/infra': 'Infra',
  '/settings': 'Settings',
  '/soma': 'Soma',
  '/watch': 'Watch',
};

export function TitanLayout() {
  const { sidebarOpen, isMobile, setSidebarOpen } = useSidebar();
  const { panelVisible, togglePanelVisible } = usePanel();
  const location = useLocation();

  // Build breadcrumbs from path
  const breadcrumbs = useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    const crumbs = [{ label: 'TITAN', path: '/dashboard' }];

    let path = '';
    for (const segment of segments) {
      path += `/${segment}`;
      const label = BREADCRUMB_MAP[path] || segment;
      crumbs.push({ label, path });
    }

    return crumbs;
  }, [location.pathname]);

  // Close sidebar on mobile when route changes
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [location.pathname, isMobile, setSidebarOpen]);

  return (
    <div className="flex h-dvh bg-[#09090b] text-[#fafafa] overflow-hidden">
      {/* Mobile overlay */}
      {isMobile && sidebarOpen && (
        <button
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      {/* Sidebar */}
      <div
        className={`flex-shrink-0 h-full transition-all duration-200 ease-out z-50 ${
          isMobile
            ? `fixed inset-y-0 left-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`
            : sidebarOpen ? 'w-60' : 'w-16'
        }`}
      >
        <TitanSidebar />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Breadcrumb bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#27272a] bg-[#09090b]/95 backdrop-blur-sm">
          <nav className="flex items-center gap-1.5 text-[11px] text-[#52525b]">
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight className="w-3 h-3 text-[#3f3f46]" />}
                <Link
                  to={crumb.path}
                  className={`hover:text-[#a1a1aa] transition-colors ${
                    i === breadcrumbs.length - 1 ? 'text-[#818cf8] font-medium' : ''
                  }`}
                >
                  {crumb.label}
                </Link>
              </span>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button
              onClick={togglePanelVisible}
              className={`p-1.5 rounded-lg transition-colors ${
                panelVisible
                  ? 'bg-[#6366f1]/10 text-[#818cf8] border border-[#6366f1]/20'
                  : 'text-[#52525b] hover:text-[#a1a1aa] hover:bg-[#27272a]/50'
              }`}
              title="Toggle properties panel"
            >
              {panelVisible ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
          <PropertiesPanel />
        </div>
      </div>
    </div>
  );
}
