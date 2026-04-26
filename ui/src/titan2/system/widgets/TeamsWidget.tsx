import React, { Suspense } from 'react';
const TeamsPanel = React.lazy(() => import('@/components/admin/TeamsPanel'));
export function TeamsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <TeamsPanel />
      </Suspense>
    </div>
  );
}
