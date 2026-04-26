import React, { Suspense } from 'react';
const SessionsPanel = React.lazy(() => import('@/components/admin/SessionsPanel'));
export function SessionsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <SessionsPanel />
      </Suspense>
    </div>
  );
}
