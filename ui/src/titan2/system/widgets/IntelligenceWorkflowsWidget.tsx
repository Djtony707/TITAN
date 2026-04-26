import React, { Suspense } from 'react';
const WorkflowsPanel = React.lazy(() => import('@/components/admin/WorkflowsPanel'));
export function IntelligenceWorkflowsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <WorkflowsPanel />
      </Suspense>
    </div>
  );
}
