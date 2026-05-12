/**
 * Tool intent classification — unit tests.
 *
 * 12 Factor §8 ("Own your control flow") says: classify each tool by
 * sync/async/destructive intent, then the harness owns the WHILE loop and
 * decides whether each step continues immediately or breaks the loop.
 *
 * v5.8.0 ships the classification layer only. The actual selection-vs-
 * invocation HOOK (where approval gates plug in) is a follow-up. But once
 * the classification exists, the agent loop can log every "about to fire
 * a destructive tool" event — observable today, gateable tomorrow.
 *
 * Reference:
 *   - https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md
 *   - awesome-agent-harness top-10 pattern #9 "Approval delegation + HITL"
 */
import { describe, it, expect } from 'vitest';
import {
    TOOL_KINDS,
    getToolKind,
    isRisky,
    isDestructive,
    isLongRunning,
    type ToolKind,
} from '../../src/agent/toolIntent.js';

describe('TOOL_KINDS — classification', () => {
    it('read-only / informational tools are sync', () => {
        for (const t of [
            'read_file', 'list_dir', 'web_search',
            'current_model', 'list_personas', 'get_persona',
            'gallery_search', 'gallery_get', 'gallery_list',
            'memory', 'graph_search',
        ]) {
            expect(getToolKind(t), `${t} should be sync`).toBe('sync');
        }
    });

    it('state-mutating but reversible tools are risky', () => {
        for (const t of [
            'write_file', 'edit_file', 'append_file', 'apply_patch',
            'graph_remember', 'switch_persona', 'switch_model',
        ]) {
            expect(getToolKind(t), `${t} should be risky`).toBe('risky');
        }
    });

    it('shell is destructive (can run rm, mutate the OS)', () => {
        expect(getToolKind('shell')).toBe('destructive');
        expect(getToolKind('execute_code')).toBe('destructive');
    });

    it('network / browser / long-running tools are long-running', () => {
        for (const t of [
            'web_fetch', 'browse_url', 'browser_screenshot', 'web_browse_llm',
            'cron', 'webhook',
        ]) {
            expect(getToolKind(t), `${t} should be long-running`).toBe('long-running');
        }
    });

    it('unknown tools default to sync (false-negative bias)', () => {
        // We don't want to over-classify random tools as destructive — that
        // would gate them unnecessarily. Default to sync; opt in to risky.
        expect(getToolKind('some_brand_new_tool')).toBe('sync');
        expect(getToolKind('')).toBe('sync');
    });
});

describe('predicates — isRisky / isDestructive / isLongRunning', () => {
    it('isRisky returns true for risky AND destructive (destructive is a superset)', () => {
        expect(isRisky('write_file')).toBe(true);
        expect(isRisky('shell')).toBe(true);  // destructive is also risky
        expect(isRisky('read_file')).toBe(false);
    });

    it('isDestructive is strict — only the destructive class', () => {
        expect(isDestructive('shell')).toBe(true);
        expect(isDestructive('execute_code')).toBe(true);
        expect(isDestructive('write_file')).toBe(false); // risky, not destructive
        expect(isDestructive('read_file')).toBe(false);
    });

    it('isLongRunning catches network/browser tools', () => {
        expect(isLongRunning('web_fetch')).toBe(true);
        expect(isLongRunning('browse_url')).toBe(true);
        expect(isLongRunning('read_file')).toBe(false);
    });
});

describe('TOOL_KINDS — registry invariants', () => {
    it('every kind is a valid ToolKind', () => {
        const valid: Set<ToolKind> = new Set(['sync', 'risky', 'destructive', 'long-running']);
        for (const [name, kind] of Object.entries(TOOL_KINDS)) {
            expect(valid.has(kind as ToolKind), `${name} has invalid kind: ${kind}`).toBe(true);
        }
    });

    it('shell is in the destructive set (regression check on the most-watched tool)', () => {
        expect(TOOL_KINDS.shell).toBe('destructive');
    });

    it('top-30 priority tools (from Phase 1 audit) all have an explicit kind', () => {
        const required = [
            'shell', 'read_file', 'write_file', 'edit_file', 'append_file', 'list_dir',
            'web_search', 'web_fetch', 'memory',
            'current_model', 'switch_model', 'switch_persona', 'list_personas', 'get_persona',
            'cron', 'webhook', 'gallery_search', 'gallery_get',
        ];
        for (const t of required) {
            expect(TOOL_KINDS, `${t} should have an explicit kind in TOOL_KINDS`).toHaveProperty(t);
        }
    });
});
