import { useState } from 'react';
import { NavLink } from 'react-router';
import { Crosshair, Shield, Brain, Wrench, Server, Settings, Heart, Users, X, Menu } from 'lucide-react';
import clsx from 'clsx';

interface NavItem {
  to: string;
  icon: typeof Crosshair;
  label: string;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: Crosshair, label: 'Mission', exact: true },
  { to: '/soma', icon: Heart, label: 'Soma' },
  { to: '/command-post', icon: Shield, label: 'Command Post' },
  { to: '/agents', icon: Users, label: 'Agents' },
  { to: '/intelligence', icon: Brain, label: 'Intelligence' },
  { to: '/tools', icon: Wrench, label: 'Tools' },
  { to: '/infra', icon: Server, label: 'Infra' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Hamburger button — visible only on small screens */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-3 left-3 z-40 p-2 rounded-lg bg-bg-secondary/80 backdrop-blur border border-border/50 text-text shadow-lg"
        aria-label="Open navigation"
      >
        <Menu size={18} />
      </button>

      {/* Slide-out overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="flex-1 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          {/* Drawer */}
          <nav className="w-64 bg-bg-secondary border-l border-border/50 flex flex-col py-4">
            <div className="flex items-center justify-between px-4 mb-4">
              <span className="text-sm font-semibold text-text">TITAN</span>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-md hover:bg-bg-tertiary text-text-muted"
                aria-label="Close navigation"
              >
                <X size={16} />
              </button>
            </div>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 px-4 py-3 text-sm transition-colors',
                    isActive
                      ? 'text-accent bg-accent/10 border-r-2 border-accent'
                      : 'text-text-secondary hover:text-text hover:bg-bg-tertiary',
                  )
                }
              >
                <item.icon size={18} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}
