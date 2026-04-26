import clsx from 'clsx';

interface ResizeHandleProps {
  isResizing: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  direction?: 'horizontal' | 'vertical';
}

export default function ResizeHandle({ isResizing, onMouseDown, direction = 'horizontal' }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';

  return (
    <div
      className={clsx(
        'group shrink-0 flex items-center justify-center transition-colors',
        isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        isResizing ? 'bg-accent/40' : 'bg-transparent hover:bg-bg-tertiary',
      )}
      onMouseDown={onMouseDown}
    >
      <div
        className={clsx(
          'rounded-full transition-all',
          isHorizontal ? 'w-[2px] h-8' : 'h-[2px] w-8',
          isResizing
            ? 'bg-accent'
            : 'bg-bg-tertiary group-hover:bg-border-light',
        )}
      />
    </div>
  );
}
