import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Paperclip, ChevronLeft, PanelLeftClose, PanelLeft } from 'lucide-react';
import clsx from 'clsx';

interface NavItem {
  label: string;
  path: string;
  icon: typeof Paperclip;
}

export function CPSidebar() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const navItems: NavItem[] = [
    { label: 'Paperclip', path: '/command-post', icon: Paperclip },
  ];

  const isActive = (_path: string) => {
    return location.pathname === '/command-post' || location.pathname.startsWith('/command-post/paperclip');
  };

  if (collapsed) {
    return (
      <div className="flex flex-col h-full w-[48px] bg-bg-secondary border-r border-border flex-shrink-0">
        <div className="flex items-center justify-center py-3 border-b border-border">
          <button
            onClick={() => setCollapsed(false)}
            className="p-1 rounded text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
            title="Expand sidebar"
          >
            <PanelLeft size={16} />
          </button>
        </div>
        <nav className="flex-1 flex flex-col items-center gap-1 px-1 py-2">
          {navItems.map((item) => {
            const active = isActive(item.path);
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={item.label}
                className={clsx(
                  'flex items-center justify-center w-9 h-9 rounded-lg transition-all',
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:text-text hover:bg-bg-tertiary',
                )}
              >
                <Icon size={16} />
              </Link>
            );
          })}
        </nav>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-[200px] bg-bg-secondary border-r border-border flex-shrink-0">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <Link to="/" className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors">
            <ChevronLeft size={14} />
            <span>Back to Chat</span>
          </Link>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        <h2 className="text-sm font-semibold text-text px-1">Command Post</h2>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {navItems.map((item) => {
          const active = isActive(item.path);
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={clsx(
                'flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-all',
                active
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'text-text-secondary hover:text-text hover:bg-bg-tertiary',
              )}
            >
              <Icon size={15} className="flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
