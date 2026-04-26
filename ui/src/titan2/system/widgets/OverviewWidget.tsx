import React, { Suspense } from 'react';
const OverviewPanel = React.lazy(() => import('@/components/admin/OverviewPanel'));
export function OverviewWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <OverviewPanel />
      </Suspense>
    </div>
  );
}
