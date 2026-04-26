import React, { Suspense } from 'react';
const MemoryWikiPanel = React.lazy(() => import('@/components/admin/MemoryWikiPanel'));
export function MemoryWikiWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <MemoryWikiPanel />
      </Suspense>
    </div>
  );
}
