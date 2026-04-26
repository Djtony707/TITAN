import React, { Suspense } from 'react';
const CronPanel = React.lazy(() => import('@/components/admin/CronPanel'));
export function CronWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <CronPanel />
      </Suspense>
    </div>
  );
}
