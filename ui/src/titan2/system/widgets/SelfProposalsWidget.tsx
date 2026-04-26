import React, { Suspense } from 'react';
const SelfProposalsPanel = React.lazy(() => import('@/components/admin/SelfProposalsPanel'));
export function SelfProposalsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <SelfProposalsPanel />
      </Suspense>
    </div>
  );
}
