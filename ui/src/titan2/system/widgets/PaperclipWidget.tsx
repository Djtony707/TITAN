import React, { Suspense } from 'react';
const PaperclipPanel = React.lazy(() => import('@/components/admin/PaperclipPanel'));
export function PaperclipWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <PaperclipPanel />
      </Suspense>
    </div>
  );
}
