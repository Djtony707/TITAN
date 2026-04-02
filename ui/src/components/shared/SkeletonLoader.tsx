import clsx from 'clsx';

type SkeletonVariant = 'card' | 'row' | 'text' | 'metric';

interface SkeletonLoaderProps {
  variant?: SkeletonVariant;
  count?: number;
  className?: string;
}

const variants: Record<SkeletonVariant, string> = {
  card: 'h-28 rounded-xl border border-border',
  row: 'h-12 rounded-lg',
  text: 'h-4 rounded',
  metric: 'h-24 rounded-xl border border-border',
};

export function SkeletonLoader({ variant = 'card', count = 1, className }: SkeletonLoaderProps) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={clsx('skeleton-shimmer', variants[variant], className)} />
      ))}
    </>
  );
}
