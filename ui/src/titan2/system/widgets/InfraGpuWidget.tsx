import React, { Suspense } from 'react';
const NvidiaPanel = React.lazy(() => import('@/components/admin/NvidiaPanel'));
export function InfraGpuWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <NvidiaPanel />
      </Suspense>
    </div>
  );
}
