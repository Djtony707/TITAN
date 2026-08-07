/**
 * TITAN — restart-required policy for POST /api/config.
 *
 * Extracted from server.ts (slice 2 patch 5 review 8e7ad98b) so the
 * decision is a pure, directly testable function: some persisted config
 * only takes effect at boot, and the API must say so instead of
 * reporting `restartRequired: false` while the process keeps running
 * the old mode.
 *
 * company.enabled / company.queue.enabled are restart-required by
 * design: the company service caches exactly one dispatcher mode (and,
 * in queue mode, a supervisor loop) for process lifetime, and the
 * company router is startup-mounted. Hot-switching would need a
 * deliberate supervisor/log teardown plus the §3 downgrade sequence —
 * a restart IS that sequence.
 */

export const RESTART_REQUIRED_PATTERNS = [
    'channels.*',
    'gateway.auth.*',
    'logging.level',
    'company.enabled',
    'company.queue.enabled',
];

/** Which of the changed fields require a restart to take effect. */
export function restartFieldsFor(changedFields: readonly string[]): string[] {
    return changedFields.filter(field =>
        RESTART_REQUIRED_PATTERNS.some(pattern => {
            if (pattern.endsWith('.*')) {
                return field.startsWith(pattern.slice(0, -1));
            }
            return field === pattern;
        })
    );
}

/**
 * Apply the `company` section of a POST /api/config body onto the config
 * draft, returning the PRECISE changed-field names (not a blanket
 * 'company') so the restart contract distinguishes flag flips from
 * cosmetic name/mission edits. Presence-based, matching the other
 * config sections: providing a value counts as a change in either
 * direction — enable AND disable both report restart-required.
 */
export function applyCompanyConfig(co: Record<string, unknown>, dco: Record<string, unknown>): string[] {
    const changed: string[] = [];
    if (co.enabled !== undefined) {
        dco.enabled = Boolean(co.enabled);
        changed.push('company.enabled');
    }
    if (co.name !== undefined && typeof co.name === 'string') {
        dco.name = co.name;
        changed.push('company.name');
    }
    if (co.mission !== undefined && typeof co.mission === 'string') {
        dco.mission = co.mission;
        changed.push('company.mission');
    }
    // v8 Slice 2 — work queue sub-flag
    if (co.queue !== undefined && typeof co.queue === 'object' && co.queue !== null) {
        const q = co.queue as Record<string, unknown>;
        if (q.enabled !== undefined) {
            if (!dco.queue) dco.queue = {};
            (dco.queue as Record<string, unknown>).enabled = Boolean(q.enabled);
            changed.push('company.queue.enabled');
        }
    }
    return changed;
}
