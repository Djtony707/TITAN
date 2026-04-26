import React, { Suspense } from 'react';
const BackupPanel = React.lazy(() => import('@/components/admin/BackupPanel'));
export function BackupWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <BackupPanel />
      </Suspense>
    </div>
  );
}
