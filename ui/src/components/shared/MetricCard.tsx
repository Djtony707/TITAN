import { type ReactNode } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import clsx from 'clsx';

interface MetricCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  trend?: 'up' | 'down';
  trendValue?: string;
  subtitle?: string;
  sparkline?: number[];
  className?: string;
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const h = 24;
  const w = 64;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - ((v - min) / range) * h}`).join(' ');

  return (
    <svg width={w} height={h} className="opacity-50">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MetricCard({ title, value, icon, trend, trendValue, subtitle, sparkline, className }: MetricCardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-border bg-bg-secondary p-4 transition-all',
        'hover:border-border-light hover:shadow-[var(--shadow-card-hover)]',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 text-text-muted">
            {icon && <span className="flex-shrink-0">{icon}</span>}
            <span className="text-xs font-medium uppercase tracking-wider">{title}</span>
          </div>
          <div className="mt-2 text-2xl font-semibold text-text">{value}</div>
        </div>
        {sparkline && (
          <div className="text-accent">
            <Sparkline data={sparkline} />
          </div>
        )}
      </div>

      {(trend || subtitle) && (
        <div className="mt-2 flex items-center gap-2">
          {trend && (
            <span className={clsx('inline-flex items-center gap-0.5 text-xs font-medium', trend === 'up' ? 'text-success' : 'text-error')}>
              {trend === 'up' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {trendValue}
            </span>
          )}
          {subtitle && <span className="text-xs text-text-muted">{subtitle}</span>}
        </div>
      )}
    </div>
  );
}
