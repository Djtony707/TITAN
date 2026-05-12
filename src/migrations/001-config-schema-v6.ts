/**
 * Migration 001 — config-schema-v6
 *
 * v6.0 adds new optional config fields (Spaces persistence, Soma profile,
 * starter preset). Existing v5.x config.yaml / config.json files keep
 * working unchanged because every new field is optional with a default,
 * but if the user has a config file on disk we want to lift it through
 * the v6 Zod parser once so the file ends up "canonicalised" with the
 * new fields populated to their defaults. That makes subsequent reads
 * faster and the Settings UI nicer.
 *
 * Idempotency: re-parsing an already-canonical config is a no-op write.
 */
import type { Migration } from './runner.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const migration: Migration = {
    id: '001-config-schema-v6',
    version: '6.0.0-beta.1',
    description: 'Lift existing config.yaml through the v6 Zod parser so new defaults populate.',

    async up(ctx) {
        // Try yaml first, then json — same logic as src/config/config.ts.
        const yamlPath = join(ctx.titanHome, 'config.yaml');
        const jsonPath = join(ctx.titanHome, 'config.json');
        const path = existsSync(yamlPath) ? yamlPath : existsSync(jsonPath) ? jsonPath : null;
        if (!path) {
            ctx.log('No config file found — fresh install, nothing to migrate.');
            return;
        }
        // Dynamic import so the migration file doesn't import the whole
        // config stack at module-load time (matters for cold-start latency).
        const { loadConfig } = await import('../config/config.js');
        try {
            // Reading triggers Zod default-filling. We re-emit only when the
            // emitted content differs from the file on disk.
            const cfg = loadConfig();
            const out = path.endsWith('.yaml') ? null : JSON.stringify(cfg, null, 2);
            if (out) {
                const changed = ctx.writeIfChanged(path === jsonPath ? 'config.json' : 'config.yaml', out);
                ctx.log(changed ? 'Canonicalised config.json with v6 defaults.' : 'Config already canonical — no write.');
            } else {
                // YAML path — we don't re-emit YAML here because the existing
                // config loader handles it lazily. Defaults will still apply
                // on every load via Zod.
                ctx.log('YAML config detected — defaults apply at load time, no rewrite needed.');
            }
        } catch (err) {
            // Malformed config — surface but don't crash the migration runner.
            // The user can fix it manually; future migrations can keep running.
            ctx.log(`Config parse failed (${(err as Error).message}) — leaving file untouched.`);
        }
    },

    async rollback(ctx) {
        // Rolling back a config canonicalisation is a no-op — the parsed
        // values were always implicit. The original file is unchanged in
        // the YAML path; the JSON path may have new default fields added,
        // but those are harmless to leave in place.
        ctx.log('rollback: nothing to undo (canonicalisation is purely additive).');
    },
};
