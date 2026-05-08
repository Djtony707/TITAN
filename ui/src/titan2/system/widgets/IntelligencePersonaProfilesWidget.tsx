import React, { Suspense } from 'react';

/**
 * Persona Profiles widget — Mission Control surface for the v5.5.24
 * runtime persona resolver. Distinct from the older PersonasWidget
 * (which surfaces the agency-agents picker at /api/personas).
 */
const PersonaProfilesPanel = React.lazy(() => import('@/components/admin/PersonaProfilesPanel'));
export function IntelligencePersonaProfilesWidget() {
  return (
    <div className="w-full h-full overflow-auto p-4">
      <Suspense fallback={<div className="text-xs text-[#52525b]">Loading...</div>}>
        <PersonaProfilesPanel />
      </Suspense>
    </div>
  );
}
