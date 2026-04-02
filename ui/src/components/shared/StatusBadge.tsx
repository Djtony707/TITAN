import clsx from 'clsx';

type BadgeVariant = 'pill' | 'dot';
type BadgeSize = 'sm' | 'md';

interface StatusBadgeProps {
  status: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
  label?: string;
  className?: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  // Active / positive
  active:     { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  running:    { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  completed:  { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  done:       { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  succeeded:  { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  enabled:    { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  healthy:    { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  approved:   { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },
  connected:  { bg: 'bg-success/10', text: 'text-success', dot: 'bg-success' },

  // In progress
  in_progress: { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },
  in_review:   { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },
  processing:  { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },
  training:    { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },
  deploying:   { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },

  // Warning
  warning:  { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning' },
  pending:  { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning' },
  queued:   { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning' },
  backlog:  { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning' },
  todo:     { bg: 'bg-warning/10', text: 'text-warning', dot: 'bg-warning' },

  // Error / negative
  error:     { bg: 'bg-error/10', text: 'text-error', dot: 'bg-error' },
  failed:    { bg: 'bg-error/10', text: 'text-error', dot: 'bg-error' },
  critical:  { bg: 'bg-error/10', text: 'text-error', dot: 'bg-error' },
  rejected:  { bg: 'bg-error/10', text: 'text-error', dot: 'bg-error' },
  blocked:   { bg: 'bg-error/10', text: 'text-error', dot: 'bg-error' },

  // Neutral
  idle:       { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' },
  disabled:   { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' },
  stopped:    { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' },
  paused:     { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' },
  cancelled:  { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' },
  unknown:    { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' },
};

const DEFAULT_COLORS = { bg: 'bg-text-muted/10', text: 'text-text-muted', dot: 'bg-text-muted' };

function getColors(status: string) {
  return STATUS_COLORS[status.toLowerCase().replace(/[- ]/g, '_')] ?? DEFAULT_COLORS;
}

export function StatusBadge({ status, variant = 'pill', size = 'sm', label, className }: StatusBadgeProps) {
  const colors = getColors(status);
  const display = label ?? status.replace(/_/g, ' ');

  if (variant === 'dot') {
    return (
      <span className={clsx('inline-flex items-center gap-1.5', className)}>
        <span className={clsx('rounded-full', colors.dot, size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2')} />
        <span className={clsx(colors.text, size === 'sm' ? 'text-xs' : 'text-sm')}>{display}</span>
      </span>
    );
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full font-medium capitalize',
        colors.bg, colors.text,
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
        className,
      )}
    >
      {display}
    </span>
  );
}
