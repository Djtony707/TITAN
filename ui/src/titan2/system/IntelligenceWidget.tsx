/**
 * Titan 3.0 Intelligence Widget
 * Wraps the existing IntelligenceView as a Canvas widget.
 */

import React, { Suspense } from 'react';
const IntelligenceView = React.lazy(() => import('@/components/intelligence/IntelligenceView'));

export function IntelligenceWidget() {
  return (
    <div className="w-full h-full overflow-auto">
      <Suspense fallback={<div className="p-4 text-xs text-[#52525b]">Loading Intelligence...</div>}>
        <IntelligenceView />
      </Suspense>
    </div>
  );
}
