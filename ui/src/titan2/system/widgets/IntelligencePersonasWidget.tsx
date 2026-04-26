import React, { Suspense } from 'react';
const PersonasPanel = React.lazy(() => import('@/components/admin/PersonasPanel'));
export function IntelligencePersonasWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <PersonasPanel />
      </Suspense>
    </div>
  );
}
