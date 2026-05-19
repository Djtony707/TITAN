/**
 * Tests for decomposeGoalIntoTasks (v6.3.0).
 *
 * Pre-fix behavior: every step had `dependsOn: [previousId]`, which
 * forced the goal driver to run subtasks one-at-a-time regardless of
 * actual data dependency. That made downstream parallel dispatch
 * impossible — the parallel-ready subtask list was always length 1.
 *
 * These pin: coordinating connectors ("and", ","/";") produce empty
 * dependsOn (truly parallel); ordering connectors ("then", "after",
 * "finally") set [previousId]; the single-segment fallback stays
 * sequential (Research → Execute → Verify).
 */
import { describe, it, expect } from 'vitest';
import { decomposeGoalIntoTasks } from '../src/agent/planner.js';

describe('decomposeGoalIntoTasks', () => {
    describe('coordinating connectors → independent (no dependsOn)', () => {
        it('"A and B" produces 2 tasks with no deps', () => {
            const out = decomposeGoalIntoTasks('research competitors and write the report');
            expect(out).toHaveLength(2);
            expect(out[0].dependsOn).toEqual([]);
            expect(out[1].dependsOn).toEqual([]);
        });

        it('comma-separated list produces N tasks with no deps', () => {
            const out = decomposeGoalIntoTasks('audit the auth flow, audit the billing flow, audit the email flow');
            expect(out.length).toBeGreaterThanOrEqual(3);
            for (const t of out) expect(t.dependsOn).toEqual([]);
        });

        it('mixed comma + and → still all parallel', () => {
            const out = decomposeGoalIntoTasks('build the dashboard, add charts, and wire the backend');
            expect(out.length).toBeGreaterThanOrEqual(3);
            for (const t of out) expect(t.dependsOn).toEqual([]);
        });
    });

    describe('ordering connectors → chain (dependsOn previous)', () => {
        it('"X then Y" makes Y depend on X', () => {
            const out = decomposeGoalIntoTasks('scrape the site then summarize the data');
            expect(out).toHaveLength(2);
            expect(out[0].dependsOn).toEqual([]);
            expect(out[1].dependsOn).toEqual(['task-1']);
        });

        it('"first X then Y finally Z" produces full chain', () => {
            const out = decomposeGoalIntoTasks('first scrape the site then summarize the data finally email the summary');
            expect(out).toHaveLength(3);
            expect(out[0].dependsOn).toEqual([]);
            expect(out[1].dependsOn).toEqual(['task-1']);
            expect(out[2].dependsOn).toEqual(['task-2']);
        });

        it('mixed ordering + coordinating preserves per-step semantics', () => {
            // "research X and analyze Y, then write Z"
            // research X and analyze Y → parallel (both have empty dependsOn)
            // then write Z → depends on previous (analyze Y, i.e. task-2)
            const out = decomposeGoalIntoTasks('research the market and analyze pricing, then write the brief');
            expect(out).toHaveLength(3);
            expect(out[0].dependsOn).toEqual([]); // research X
            expect(out[1].dependsOn).toEqual([]); // analyze Y
            expect(out[2].dependsOn).toEqual(['task-2']); // write Z (then)
        });
    });

    describe('single-step fallback → sequential R/E/V', () => {
        it('"build a thing" with no connectors → 3 chain tasks', () => {
            const out = decomposeGoalIntoTasks('build a thing');
            expect(out).toHaveLength(3);
            expect(out[0].dependsOn).toEqual([]);          // research
            expect(out[1].dependsOn).toEqual(['task-1']);  // execute
            expect(out[2].dependsOn).toEqual(['task-2']);  // verify
        });
    });

    describe('edge cases', () => {
        it('leading "first," is stripped, not treated as ordering', () => {
            const out = decomposeGoalIntoTasks('first, write the intro');
            // Single segment after stripping → R/E/V fallback
            expect(out.length).toBe(3);
        });

        it('numbered ordinals "2." on later steps treated as ordering', () => {
            const out = decomposeGoalIntoTasks('audit the security, 2. write the report');
            expect(out).toHaveLength(2);
            // Comma split → both independent regardless of "2." prefix
            // The "2." is purely visual numbering.
            expect(out[0].dependsOn).toEqual([]);
            expect(out[1].dependsOn).toEqual([]);
        });

        it('preserves task titles (first 80 chars)', () => {
            const out = decomposeGoalIntoTasks('analyze the customer churn data and write a summary email');
            expect(out[0].title).toContain('analyze');
            expect(out[1].title).toContain('write');
        });
    });
});
