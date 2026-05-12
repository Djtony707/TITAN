/**
 * Migration 004 — user-data-dirs
 *
 * v6.0 introduces per-user data directories under `~/.titan/users/<userId>/`
 * to support the personal widget gallery (gallery.json), pattern detection
 * (patterns.json), and Soma profile (soma.json). This migration creates
 * the directory structure so subsequent writes don't have to keep checking
 * existence.
 *
 * Single-user installs get one `default-user` dir. Multi-user installs (rare
 * today, common when v6 hits production) get one dir per registered userId
 * once the auth-tokens.json migration code-path actually creates them at
 * login time.
 */
import type { Migration } from './runner.js';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export const migration: Migration = {
    id: '004-user-data-dirs',
    version: '6.0.0-beta.1',
    description: 'Create per-user data directories under ~/.titan/users/.',

    async up(ctx) {
        const usersRoot = join(ctx.titanHome, 'users');
        const defaultUserDir = join(usersRoot, 'default-user');
        // mkdir -p semantics — safe to call when the dir already exists.
        try { mkdirSync(defaultUserDir, { recursive: true }); } catch { /* ignore */ }
        // Touch each subdir we'll reference by name so tooling that does
        // `existsSync(dir)` checks doesn't have to handle the missing-case.
        for (const sub of ['widgets', 'patterns', 'gallery']) {
            try { mkdirSync(join(defaultUserDir, sub), { recursive: true }); } catch { /* ignore */ }
        }
        ctx.log(`Ensured ~/.titan/users/default-user/{widgets,patterns,gallery}/`);
        // Validate
        if (!existsSync(defaultUserDir)) {
            throw new Error(`could not create ${defaultUserDir} (permissions?)`);
        }
    },

    async rollback(ctx) {
        // We never remove user data dirs in rollback — losing widgets /
        // patterns / gallery the user has built is unacceptable. The dirs
        // are cheap to leave behind even if v6 features get reverted.
        ctx.log('rollback: preserving user data dirs (never destructive).');
    },
};
