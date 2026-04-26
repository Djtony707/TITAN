import React, { Suspense } from 'react';
const FleetPanel = React.lazy(() => import('@/components/admin/FleetPanel'));
export function FleetWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <FleetPanel />
      </Suspense>
    </div>
  );
}
