import React, { Suspense } from 'react';
const EvalPanel = React.lazy(() => import('@/components/admin/EvalPanel'));
export function EvalWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <EvalPanel />
      </Suspense>
    </div>
  );
}
