import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { QuickSwitcher } from '@/components/shared/QuickSwitcher';
import { Menu, X } from 'lucide-react';

export function Layout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<'chat' | 'admin'>('chat');
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const location = useLocation();

  // Cmd+K / Ctrl+K to open QuickSwitcher
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setQuickSwitcherOpen(prev => !prev);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const sidebarWidth = sidebarMode === 'chat' ? 60 : collapsed ? 64 : 240;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — desktop */}
      <div
        className="hidden md:flex flex-shrink-0 transition-all duration-200"
        style={{ width: sidebarWidth }}
      >
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
          mode={sidebarMode}
          onModeChange={setSidebarMode}
        />
      </div>

      {/* Sidebar — mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 md:hidden transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ width: 240 }}
      >
        <Sidebar
          collapsed={false}
          onToggle={() => setMobileOpen(false)}
          mode={sidebarMode}
          onModeChange={setSidebarMode}
        />
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar>
          <button
            className="md:hidden p-1.5 rounded-md text-text-secondary hover:text-text hover:bg-bg-tertiary"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </TopBar>
        <AnimatePresence mode="wait">
          <motion.main
            key={location.pathname}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="flex-1 overflow-auto"
          >
            {children}
          </motion.main>
        </AnimatePresence>
      </div>

      {/* Quick Switcher */}
      <QuickSwitcher open={quickSwitcherOpen} onClose={() => setQuickSwitcherOpen(false)} />
    </div>
  );
}
