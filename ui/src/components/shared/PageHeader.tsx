import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';

interface Breadcrumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, breadcrumbs, actions }: PageHeaderProps) {
  return (
    <header className="titan-window-titlebar mb-4 md:mb-6">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-1 overflow-x-auto pb-1 text-[10px] text-text-muted scrollbar-thin md:text-xs" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1 flex-shrink-0">
              {i > 0 && <ChevronRight size={12} className="opacity-50 flex-shrink-0" />}
              {crumb.href ? (
                <Link to={crumb.href} className="whitespace-nowrap transition-colors hover:text-text">{crumb.label}</Link>
              ) : (
                <span className={i === breadcrumbs.length - 1 ? 'text-text-secondary whitespace-nowrap' : ''}>{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-1 hidden h-3.5 w-11 shrink-0 items-center gap-1.5 md:flex" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-error/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-warning/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/80" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-text md:text-xl">{title}</h1>
            {subtitle && <p className="mt-1 max-w-3xl text-[11px] leading-5 text-text-muted md:text-sm">{subtitle}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </header>
  );
}
