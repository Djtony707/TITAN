import React, { Suspense } from 'react';
const SelfImprovePanel = React.lazy(() => import('@/components/admin/SelfImprovePanel'));
export function IntelligenceSelfImproveWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <SelfImprovePanel />
      </Suspense>
    </div>
  );
}
