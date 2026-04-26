import React, { Suspense } from 'react';
const FilesPanel = React.lazy(() => import('@/components/admin/FilesPanel'));
export function InfraFilesWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <FilesPanel />
      </Suspense>
    </div>
  );
}
