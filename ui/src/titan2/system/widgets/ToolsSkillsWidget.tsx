import React, { Suspense } from 'react';
const SkillsPanel = React.lazy(() => import('@/components/admin/SkillsPanel'));
export function ToolsSkillsWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <SkillsPanel />
      </Suspense>
    </div>
  );
}
