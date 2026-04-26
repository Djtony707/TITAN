import React, { Suspense } from 'react';
const MeshPanel = React.lazy(() => import('@/components/admin/MeshPanel'));
export function ToolsMeshWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <MeshPanel />
      </Suspense>
    </div>
  );
}
