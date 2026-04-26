import React, { Suspense } from 'react';
const IntegrationsPanel = React.lazy(() => import('@/components/admin/IntegrationsPanel'));
export function ToolsIntegrationsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <IntegrationsPanel />
      </Suspense>
    </div>
  );
}
