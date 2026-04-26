import React, { Suspense } from 'react';
const AutopilotPanel = React.lazy(() => import('@/components/admin/AutopilotPanel'));
export function IntelligenceAutopilotWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <AutopilotPanel />
      </Suspense>
    </div>
  );
}
