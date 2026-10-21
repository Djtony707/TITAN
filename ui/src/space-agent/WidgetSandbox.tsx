import React from 'react';
import type { Widget } from './types';

interface Props {
  widget: Widget;
  onRemove: (id: string) => void;
}

/** Dormant compatibility export. No generated code, iframe or parent proxy runs. */
export const WidgetSandbox: React.FC<Props> = ({ widget, onRemove }) => (
  <div className="relative w-full h-full rounded-lg overflow-hidden border border-gray-700 bg-[#0f1117]">
    <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700">
      <span className="text-xs font-medium text-gray-300 truncate">{widget.title}</span>
      <button type="button" aria-label="Remove widget" onClick={() => onRemove(widget.id)} className="text-gray-500 hover:text-red-400 transition-colors text-xs px-1">×</button>
    </div>
    <p role="status" className="p-3 text-xs text-gray-300">Widget preview is disabled by a security hold pending scoped permissions.</p>
  </div>
);
