import { type ReactNode } from 'react';
import { Button } from './Button';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={`titan-empty-state flex flex-col items-center justify-center px-6 py-14 text-center ${className ?? ''}`}>
      {icon && <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-md border text-text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      {description && <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">{description}</p>}
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick} className="mt-4">
          {action.label}
        </Button>
      )}
    </div>
  );
}
