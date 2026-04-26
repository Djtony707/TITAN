import React, { Suspense } from 'react';
const SecurityPanel = React.lazy(() => import('@/components/admin/SecurityPanel'));
export function SettingsSecurityWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <SecurityPanel />
      </Suspense>
    </div>
  );
}
