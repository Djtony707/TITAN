import type { ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  trend?: 'up' | 'down';
  subtitle?: string;
}

export function StatCard({ title, value, icon, trend, subtitle }: StatCardProps) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3 md:p-4 min-h-[100px]">
      {icon && <div className="mb-1.5 md:mb-2 text-text-muted">{icon}</div>}
      <p className="text-[11px] md:text-sm text-text-secondary">{title}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl md:text-2xl font-semibold text-text">{value}</span>
        {trend && (
          <span
            className={
              trend === 'up' ? 'text-xs md:text-sm text-success' : 'text-xs md:text-sm text-error'
            }
          >
            {trend === 'up' ? '\u2191' : '\u2193'}
          </span>
        )}
      </div>
      {subtitle && <p className="mt-1 text-[10px] md:text-xs text-text-muted">{subtitle}</p>}
    </div>
  );
}
