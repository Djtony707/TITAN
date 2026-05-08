import React, { Suspense } from 'react';

/**
 * Dream Mode widget — surfaces the v5.5.17+ nightly journal entries.
 */
const DreamPanel = React.lazy(() => import('@/components/admin/DreamPanel'));
export function IntelligenceDreamWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <DreamPanel />
      </Suspense>
    </div>
  );
}
