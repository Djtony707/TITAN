import React, { Suspense } from 'react';
const HomelabPanel = React.lazy(() => import('@/components/admin/HomelabPanel'));
export function InfraHomelabWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <HomelabPanel />
      </Suspense>
    </div>
  );
}
