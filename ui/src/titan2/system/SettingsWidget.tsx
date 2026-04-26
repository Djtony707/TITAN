/**
 * Titan 3.0 Settings Widget
 * Wraps the existing SettingsView as a Canvas widget.
 */

import React, { Suspense } from 'react';
const SettingsView = React.lazy(() => import('@/components/settings/SettingsView'));

export function SettingsWidget() {
  return (
    <div className="w-full h-full overflow-auto">
      <Suspense fallback={<div className="p-4 text-xs text-[#52525b]">Loading Settings...</div>}>
        <SettingsView />
      </Suspense>
    </div>
  );
}
