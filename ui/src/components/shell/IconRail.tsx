import { NavLink } from 'react-router';
import { Crosshair, Shield, Brain, Wrench, Server, Settings, Zap } from 'lucide-react';
import clsx from 'clsx';

const NAV_ITEMS = [
  { to: '/', icon: Crosshair, label: 'Mission', exact: true },
  { to: '/command-post', icon: Shield, label: 'Command Post' },
  { to: '/intelligence', icon: Brain, label: 'Intelligence' },
  { to: '/tools', icon: Wrench, label: 'Tools' },
  { to: '/infra', icon: Server, label: 'Infrastructure' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function IconRail() {
  return (
    <nav
      className="flex flex-col items-center w-14 shrink-0 py-3 gap-1"
      style={{ background: 'var(--color-rail-bg)', boxShadow: 'var(--shadow-rail)' }}
    >
      {/* Logo */}
      <div className="flex items-center justify-center w-9 h-9 mb-4 rounded-lg bg-accent/20">
        <Zap size={18} className="text-accent" />
      </div>

      {/* Nav items */}
      {NAV_ITEMS.map(({ to, icon: Icon, label, exact }) => (
        <NavLink
          key={to}
          to={to}
          end={exact}
          className={({ isActive }) =>
            clsx(
              'group relative flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-150',
              isActive
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:text-text hover:bg-white/[0.04]',
            )
          }
        >
          {({ isActive }) => (
            <>
              {/* Active indicator */}
              {isActive && (
                <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-accent" />
              )}
              <Icon size={20} strokeWidth={isActive ? 2 : 1.5} />
              {/* Tooltip */}
              <div className="absolute left-12 px-2 py-1 text-xs font-medium rounded-md bg-bg-tertiary text-text opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
                {label}
              </div>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
