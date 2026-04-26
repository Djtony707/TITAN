import React, { Suspense } from 'react';
const McpPanel = React.lazy(() => import('@/components/admin/McpPanel'));
export function ToolsMcpWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <McpPanel />
      </Suspense>
    </div>
  );
}
