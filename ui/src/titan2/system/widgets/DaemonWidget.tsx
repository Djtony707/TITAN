import React, { Suspense } from 'react';
const DaemonPanel = React.lazy(() => import('@/components/admin/DaemonPanel'));
export function DaemonWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <DaemonPanel />
      </Suspense>
    </div>
  );
}
