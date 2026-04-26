import React, { Suspense } from 'react';
const CheckpointsPanel = React.lazy(() => import('@/components/admin/CheckpointsPanel'));
export function CheckpointsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <CheckpointsPanel />
      </Suspense>
    </div>
  );
}
