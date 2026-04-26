/**
 * Titan 3.0 Tools Widget
 * Wraps the existing ToolsView as a Canvas widget.
 */

import React, { Suspense } from 'react';
const ToolsView = React.lazy(() => import('@/components/tools/ToolsView'));

export function ToolsWidget() {
  return (
    <div className="w-full h-full overflow-auto">
      <Suspense fallback={<div className="p-4 text-xs text-[#52525b]">Loading Tools...</div>}>
        <ToolsView />
      </Suspense>
    </div>
  );
}
