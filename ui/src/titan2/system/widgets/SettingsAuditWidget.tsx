import React, { Suspense } from 'react';
const AuditPanel = React.lazy(() => import('@/components/admin/AuditPanel'));
export function SettingsAuditWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <AuditPanel />
      </Suspense>
    </div>
  );
}
