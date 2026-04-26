import React, { Suspense } from 'react';
const SettingsPanel = React.lazy(() => import('@/components/admin/SettingsPanel'));
export function SettingsGeneralWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <SettingsPanel />
      </Suspense>
    </div>
  );
}
