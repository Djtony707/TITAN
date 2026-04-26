import React, { Suspense } from 'react';
const TrainingPanel = React.lazy(() => import('@/components/admin/TrainingPanel'));
export function TrainingWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <TrainingPanel />
      </Suspense>
    </div>
  );
}
