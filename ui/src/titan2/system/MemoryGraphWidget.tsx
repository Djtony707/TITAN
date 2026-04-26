/**
 * Titan 3.0 Memory Graph Widget
 * Direct access to the Memory Graph as a standalone Canvas widget.
 * No tabs, no wrapper — just the full interactive knowledge graph.
 */

import React, { Suspense } from 'react';
const MemoryGraphPanel = React.lazy(() => import('@/components/admin/MemoryGraphPanel'));

export function MemoryGraphWidget() {
  return (
    <div className="w-full h-full overflow-auto bg-[#09090b]">
      <Suspense fallback={
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 rounded-full border-2 border-[#6366f1]/20 border-t-[#6366f1] animate-spin mx-auto mb-3" />
            <p className="text-[11px] text-[#52525b]">Loading memory graph...</p>
          </div>
        </div>
      }>
        <div className="p-4">
          <MemoryGraphPanel />
        </div>
      </Suspense>
    </div>
  );
}
