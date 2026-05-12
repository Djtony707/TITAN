/**
 * Migration 002 — seed-default-space
 *
 * v6.0 promotes Spaces to first-class. If the user has no spaces.json yet,
 * seed a Default Space so they land somewhere useful on first boot rather
 * than an empty canvas. v5.x users with browser-localStorage Spaces will
 * have those sync'd to disk by the running gateway on next visit (handled
 * by the SpaceEngine server-sync path); this migration just covers the
 * "I'm a totally new install" case.
 */
import type { Migration } from './runner.js';

interface PersistedSpace {
    id: string;
    name: string;
    icon?: string;
    color?: string;
    widgets: unknown[];
    agentInstructions?: string;
    createdAt: string;
    updatedAt: string;
}

interface PersistedSpacesFile {
    schema: 1;
    spaces: PersistedSpace[];
    activeSpaceId?: string;
}

export const migration: Migration = {
    id: '002-seed-default-space',
    version: '6.0.0-beta.1',
    description: 'Seed a Default Space when spaces.json is absent so users land somewhere useful.',

    async up(ctx) {
        const existing = ctx.readJson<PersistedSpacesFile>('spaces.json');
        if (existing && Array.isArray(existing.spaces) && existing.spaces.length > 0) {
            ctx.log(`Skipped — ${existing.spaces.length} space(s) already configured.`);
            return;
        }
        const now = new Date().toISOString();
        const seed: PersistedSpacesFile = {
            schema: 1,
            spaces: [
                {
                    id: 'default',
                    name: 'Default',
                    icon: '🏠',
                    color: '#3b82f6',
                    widgets: [],
                    agentInstructions:
                        'You are TITAN. The user is in their Default Space — their home canvas. ' +
                        'When they ask for a tool, widget, dashboard, or visual surface, build it ' +
                        'on the spot via `create_widget`. When they describe a new domain of work, ' +
                        'propose creating a dedicated Space for it via `create_space`.',
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            activeSpaceId: 'default',
        };
        ctx.writeJson('spaces.json', seed);
        ctx.log('Created Default Space.');
    },

    async rollback(ctx) {
        // Only delete the file if the only space is the default we seeded
        // — never wipe spaces the user created themselves.
        const f = ctx.readJson<PersistedSpacesFile>('spaces.json');
        if (f && Array.isArray(f.spaces) && f.spaces.length === 1 && f.spaces[0].id === 'default') {
            ctx.log('Rolling back seed — removing untouched default space.');
            // We don't actually unlink in rollback; we just clear the array so
            // a re-run of 002 will re-seed. This is the safer behaviour for
            // a multi-migration rollback chain.
            ctx.writeJson('spaces.json', { schema: 1, spaces: [], activeSpaceId: undefined });
        } else {
            ctx.log('rollback: user has added their own spaces — leaving spaces.json untouched.');
        }
    },
};
