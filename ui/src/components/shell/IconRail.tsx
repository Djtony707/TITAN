import { NavLink } from 'react-router';
import {
  Crosshair, Shield, Brain, Wrench, Server, Settings, Heart, Users,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  group: 'primary' | 'ops' | 'admin';
}

const NAV_ITEMS: NavItem[] = [
  // Primary mission-control views
  { to: '/',             icon: Crosshair, label: 'Mission',        exact: true, group: 'primary' },
  { to: '/soma',         icon: Heart,     label: 'Soma',                       group: 'primary' },
  // Operations — day-to-day interactions with agents, goals, tools
  { to: '/command-post', icon: Shield,    label: 'Command Post',               group: 'ops' },
  { to: '/agents',       icon: Users,     label: 'Agents',                     group: 'ops' },
  { to: '/intelligence', icon: Brain,     label: 'Intelligence',               group: 'ops' },
  { to: '/tools',        icon: Wrench,    label: 'Tools',                      group: 'ops' },
  // Admin — infra + config
  { to: '/infra',        icon: Server,    label: 'Infrastructure',             group: 'admin' },
  { to: '/settings',     icon: Settings,  label: 'Settings',                   group: 'admin' },
];

function RailItem({ item }: { item: NavItem }) {
  return (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.exact}
      title={item.label}
      aria-label={item.label}
      className={({ isActive }) =>
        clsx(
          'group relative flex items-center justify-center w-11 h-11 rounded-xl transition-all duration-200',
          isActive
            ? 'text-accent-light'
            : 'text-text-muted hover:text-text',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Active indicator — gradient accent bar on the left */}
          {isActive && (
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full"
              style={{ background: 'var(--gradient-accent)' }}
            />
          )}

          {/* Icon background — animated on active, subtle on hover */}
          <span
            aria-hidden
            className={clsx(
              'absolute inset-1 rounded-xl transition-all duration-200',
              isActive
                ? 'bg-accent/10 ring-1 ring-accent/30 shadow-[0_0_18px_rgba(99,102,241,0.25)]'
                : 'bg-transparent group-hover:bg-white/[0.04] group-hover:ring-1 group-hover:ring-white/[0.06]',
            )}
          />

          {/* Icon */}
          <item.icon
            size={20}
            strokeWidth={isActive ? 2.25 : 1.75}
            className="relative z-10 transition-transform duration-200 group-hover:scale-110"
          />

          {/* Hover tooltip pill — slides in from the right */}
          <span
            className={clsx(
              'pointer-events-none absolute left-full ml-2 whitespace-nowrap',
              'rounded-md border border-white/[0.06] bg-bg-secondary px-2 py-1',
              'text-[11px] font-medium text-text shadow-lg',
              'opacity-0 -translate-x-1 transition-all duration-150',
              'group-hover:opacity-100 group-hover:translate-x-0',
              'z-50',
            )}
          >
            {item.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

function GroupDivider() {
  return (
    <div
      aria-hidden
      className="my-1.5 h-px w-6 self-center"
      style={{ background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.08), transparent)' }}
    />
  );
}

export default function IconRail() {
  const primary = NAV_ITEMS.filter(i => i.group === 'primary');
  const ops = NAV_ITEMS.filter(i => i.group === 'ops');
  const admin = NAV_ITEMS.filter(i => i.group === 'admin');

  return (
    <nav
      className="relative flex flex-col items-center w-16 shrink-0 py-3 gap-0.5"
      style={{
        background: 'linear-gradient(180deg, var(--color-rail-bg) 0%, #07070a 100%)',
        boxShadow: 'var(--shadow-rail)',
      }}
    >
      {/* Logo — uses the TITAN logo from /public, consistent with the
          expanded Sidebar, with a subtle accent-gradient ring. */}
      <NavLink
        to="/"
        end
        title="TITAN"
        aria-label="TITAN Home"
        className="flex items-center justify-center w-10 h-10 mb-3 rounded-xl relative group"
      >
        <span
          aria-hidden
          className="absolute inset-0 rounded-xl opacity-70 group-hover:opacity-100 transition-opacity"
          style={{ background: 'var(--gradient-accent-subtle)' }}
        />
        <img
          src="/titan-logo.png"
          alt="TITAN"
          className="relative w-8 h-8 rounded-lg"
        />
      </NavLink>

      {/* Primary nav */}
      {primary.map(item => <RailItem key={item.to} item={item} />)}

      <GroupDivider />

      {/* Ops nav */}
      {ops.map(item => <RailItem key={item.to} item={item} />)}

      {/* Pinned-bottom admin section */}
      <div className="mt-auto flex flex-col items-center gap-0.5 pt-2">
        <GroupDivider />
        {admin.map(item => <RailItem key={item.to} item={item} />)}
      </div>
    </nav>
  );
}
