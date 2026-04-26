import React, { Suspense } from 'react';
const TelemetryPanel = React.lazy(() => import('@/components/admin/TelemetryPanel'));
export function InfraTelemetryWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <TelemetryPanel />
      </Suspense>
    </div>
  );
}
