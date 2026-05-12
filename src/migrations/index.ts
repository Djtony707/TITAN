/**
 * TITAN — Migration Registry (U2)
 *
 * Single source of truth for which migrations exist. Each new migration
 * gets appended in id-ascending order. The runner sorts and executes from
 * here, so order in this array isn't load-bearing — but keeping it sorted
 * makes the diff readable.
 *
 * Convention: id is `NNN-kebab-slug` (e.g. `001-localstorage-spaces-to-server`)
 * where NNN is a zero-padded sequence number. This gives deterministic sort
 * order and makes hash collisions impossible.
 */
import type { Migration } from './runner.js';
import { migration as m001 } from './001-config-schema-v6.js';
import { migration as m002 } from './002-seed-default-space.js';
import { migration as m003 } from './003-soma-profile-default.js';
import { migration as m004 } from './004-user-data-dirs.js';
import { migration as m005 } from './005-route-redirects.js';

export const ALL_MIGRATIONS: Migration[] = [
    m001,
    m002,
    m003,
    m004,
    m005,
];

export type { Migration, MigrationContext, MigrationRunResult, MigrationState } from './runner.js';
export { runMigrations, planMigrations, rollbackMigration } from './runner.js';
