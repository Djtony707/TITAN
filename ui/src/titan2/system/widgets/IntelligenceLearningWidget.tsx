import React, { Suspense } from 'react';
const LearningPanel = React.lazy(() => import('@/components/admin/LearningPanel'));
export function IntelligenceLearningWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <LearningPanel />
      </Suspense>
    </div>
  );
}
