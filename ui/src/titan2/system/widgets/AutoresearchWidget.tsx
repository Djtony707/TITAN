import React, { Suspense } from 'react';
const AutoresearchPanel = React.lazy(() => import('@/components/admin/AutoresearchPanel'));
export function AutoresearchWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <AutoresearchPanel />
      </Suspense>
    </div>
  );
}
