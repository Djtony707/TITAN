import React, { Suspense } from 'react';
const OrganismPanel = React.lazy(() => import('@/components/admin/OrganismPanel'));
export function OrganismWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <OrganismPanel />
      </Suspense>
    </div>
  );
}
