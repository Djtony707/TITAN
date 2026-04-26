import React, { Suspense } from 'react';
const BrowserPanel = React.lazy(() => import('@/components/admin/BrowserPanel'));
export function BrowserWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <BrowserPanel />
      </Suspense>
    </div>
  );
}
