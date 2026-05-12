/**
 * Migration 003 — soma-profile-default
 *
 * v6.0 introduces a per-user Soma profile that tracks how TITAN attunes
 * to each user over time (working hours, preferred Spaces, response style,
 * long-term emotional baseline). This migration seeds an empty profile so
 * the runtime never has to special-case "first encounter."
 *
 * Path: `~/.titan/users/<userId>/soma.json`. For single-user installs the
 * userId is `default-user` (per src/gateway/server.ts getUserIdFromReq).
 */
import type { Migration } from './runner.js';
import { existsSync } from 'fs';
import { join } from 'path';

interface SomaProfile {
    schema: 1;
    userId: string;
    createdAt: string;
    updatedAt: string;
    /** Soma's learned baseline for THIS user's normal drive levels. */
    baseline: {
        curiosity: number;
        focus: number;
        fatigue: number;
        satisfaction: number;
        frustration: number;
    };
    /** Working-hours heuristic populated as Soma observes the user. */
    workingHours?: {
        timezone: string;
        weekdayStartHour?: number;
        weekdayEndHour?: number;
    };
    /** Free-form notes Soma can grow over time. */
    learnedAboutUser: string[];
}

export const migration: Migration = {
    id: '003-soma-profile-default',
    version: '6.0.0-beta.1',
    description: 'Seed per-user Soma profile (~/.titan/users/<userId>/soma.json).',

    async up(ctx) {
        const userId = 'default-user';
        const rel = join('users', userId, 'soma.json');
        const full = join(ctx.titanHome, rel);
        if (existsSync(full)) {
            ctx.log(`Skipped — soma profile already exists for ${userId}.`);
            return;
        }
        const now = new Date().toISOString();
        const profile: SomaProfile = {
            schema: 1,
            userId,
            createdAt: now,
            updatedAt: now,
            // 0.5 = neutral baseline. Soma adjusts these as it observes the user.
            // Curiosity defaults slightly high (0.6) so v6 leans toward suggesting
            // new Spaces / widgets out of the gate, then calibrates.
            baseline: {
                curiosity: 0.6,
                focus: 0.5,
                fatigue: 0.4,
                satisfaction: 0.5,
                frustration: 0.3,
            },
            learnedAboutUser: [],
        };
        ctx.writeJson(rel, profile);
        ctx.log(`Seeded soma profile for ${userId}.`);
    },

    async rollback(ctx) {
        // Soma profile is the only artifact this migration creates, and
        // wiping it loses observation history. Only remove if the file is
        // exactly the freshly-seeded version (no observations yet).
        const userId = 'default-user';
        const rel = join('users', userId, 'soma.json');
        const profile = ctx.readJson<SomaProfile>(rel);
        if (!profile) { ctx.log('rollback: nothing to undo (no profile).'); return; }
        if (profile.learnedAboutUser.length === 0) {
            // Safe to remove — Soma hasn't learned anything yet.
            try {
                require('fs').unlinkSync(join(ctx.titanHome, rel));
                ctx.log(`Rolled back — removed untouched soma profile for ${userId}.`);
            } catch (err) {
                ctx.log(`rollback unlink failed: ${(err as Error).message}`);
            }
        } else {
            ctx.log(`rollback: profile has ${profile.learnedAboutUser.length} observations — preserving.`);
        }
    },
};
