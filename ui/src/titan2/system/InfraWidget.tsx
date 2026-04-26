/**
 * Titan 3.0 Infrastructure Widget
 * Wraps the existing InfraView as a Canvas widget.
 */

import React, { Suspense } from 'react';
const InfraView = React.lazy(() => import('@/components/infra/InfraView'));

export function InfraWidget() {
  return (
    <div className="w-full h-full overflow-auto">
      <Suspense fallback={<div className="p-4 text-xs text-[#52525b]">Loading Infrastructure...</div>}>
        <InfraView />
      </Suspense>
    </div>
  );
}
