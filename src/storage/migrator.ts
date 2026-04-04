/**
 * TITAN — PostgreSQL Migration Runner
 * Reads .sql files from src/storage/migrations/ in filename order,
 * tracks applied migrations in a `migrations` table, and runs
 * any that have not yet been applied.
 *
 * Safe to call on every startup — already-applied migrations are skipped.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Pool } from 'pg';
import logger from '../utils/logger.js';

const COMPONENT = 'Migrator';

// Resolve migrations directory relative to this file (works in both src/ and dist/)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(pool: Pool): Promise<void> {
    // Ensure the migrations tracking table exists first
    await pool.query(`
        CREATE TABLE IF NOT EXISTS migrations (
            id          SERIAL PRIMARY KEY,
            filename    TEXT NOT NULL UNIQUE,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    if (!existsSync(MIGRATIONS_DIR)) {
        logger.warn(COMPONENT, `Migrations directory not found: ${MIGRATIONS_DIR}`);
        return;
    }

    // Read all .sql files, sort lexicographically (001_ < 002_ < …)
    const files = readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    if (files.length === 0) {
        logger.info(COMPONENT, 'No migration files found');
        return;
    }

    // Load already-applied filenames
    const { rows } = await pool.query<{ filename: string }>(
        'SELECT filename FROM migrations ORDER BY id ASC'
    );
    const applied = new Set(rows.map(r => r.filename));

    let ran = 0;
    for (const file of files) {
        if (applied.has(file)) continue;

        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
        logger.info(COMPONENT, `Applying migration: ${file}`);

        // Each migration runs in its own transaction for safety
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(
                'INSERT INTO migrations (filename) VALUES ($1)',
                [file]
            );
            await client.query('COMMIT');
            ran++;
            logger.info(COMPONENT, `Migration applied: ${file}`);
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error(COMPONENT, `Migration failed: ${file} — ${(err as Error).message}`);
            throw err; // halt startup on migration failure
        } finally {
            client.release();
        }
    }

    if (ran > 0) {
        logger.info(COMPONENT, `${ran} migration(s) applied`);
    } else {
        logger.info(COMPONENT, 'Database schema is up to date');
    }
}
