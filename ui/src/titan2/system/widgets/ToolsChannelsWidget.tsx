import React, { Suspense } from 'react';
const ChannelsPanel = React.lazy(() => import('@/components/admin/ChannelsPanel'));
export function ToolsChannelsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <ChannelsPanel />
      </Suspense>
    </div>
  );
}
