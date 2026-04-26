import React, { Suspense } from 'react';
const LogsPanel = React.lazy(() => import('@/components/admin/LogsPanel'));
export function InfraLogsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <LogsPanel />
      </Suspense>
    </div>
  );
}
