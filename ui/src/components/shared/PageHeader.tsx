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
    <div className="mb-4 md:mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="mb-2 flex items-center gap-1 text-[10px] md:text-xs text-text-muted overflow-x-auto scrollbar-thin pb-1">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1 flex-shrink-0">
              {i > 0 && <ChevronRight size={12} className="opacity-50 flex-shrink-0" />}
              {crumb.href ? (
                <Link to={crumb.href} className="hover:text-text transition-colors whitespace-nowrap">{crumb.label}</Link>
              ) : (
                <span className={i === breadcrumbs.length - 1 ? 'text-text-secondary whitespace-nowrap' : ''}>{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-semibold text-text">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[11px] md:text-sm text-text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
