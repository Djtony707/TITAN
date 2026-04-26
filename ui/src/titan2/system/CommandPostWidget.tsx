/**
 * Titan 3.0 Command Post Widget
 * Wraps the existing CommandPostHub as a Canvas widget.
 */

import React, { Suspense } from 'react';
const CommandPostHub = React.lazy(() => import('@/components/admin/CommandPostHub'));

export function CommandPostWidget() {
  return (
    <div className="w-full h-full overflow-auto p-2">
      <Suspense fallback={<div className="p-4 text-xs text-[#52525b]">Loading Command Post...</div>}>
        <CommandPostHub />
      </Suspense>
    </div>
  );
}
