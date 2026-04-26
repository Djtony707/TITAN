import React, { Suspense } from 'react';
const WatchView = React.lazy(() => import('@/views/WatchView'));
export function WatchWidget() {
  return (
    <div className="w-full h-full overflow-auto">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <WatchView />
      </Suspense>
    </div>
  );
}
