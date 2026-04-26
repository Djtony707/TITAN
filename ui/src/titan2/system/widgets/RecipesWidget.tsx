import React, { Suspense } from 'react';
const RecipesPanel = React.lazy(() => import('@/components/admin/RecipesPanel'));
export function RecipesWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <RecipesPanel />
      </Suspense>
    </div>
  );
}
