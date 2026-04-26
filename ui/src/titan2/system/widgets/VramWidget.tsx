import React, { Suspense } from 'react';
const VramPanel = React.lazy(() => import('@/components/admin/VramPanel'));
export function VramWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <VramPanel />
      </Suspense>
    </div>
  );
}
