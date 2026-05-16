/**
 * TITAN — Tool Contract unit tests (v6.1.0-beta.15, Phase D.3)
 *
 * Verifies:
 *   1. The contract validator accepts well-shaped args and rejects
 *      malformed ones with a structured ToolValidationError.
 *   2. The contract registry round-trips entries.
 *   3. Every canonical contract:
 *        - has a non-empty name + summary
 *        - has at least one exampleCall
 *        - has all exampleCalls validate against its own input schema
 *          (catches "I changed the schema but forgot the example")
 *   4. The contract registry resolves canonical skill names.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
    validateToolCall,
    ToolValidationError,
    formatValidationError,
    registerToolContract,
    getToolContract,
    listToolContracts,
    clearToolContracts,
    type ToolContract,
} from '../src/agent/toolContract.js';
import {
    registerCanonicalContracts,
    listCanonicalContracts,
} from '../src/skills/builtin/contracts.js';

/* ──────────────────────────  validateToolCall  ────────────────────────── */

describe('validateToolCall — happy path', () => {
    const contract: ToolContract<{ path: string; n: number }, string> = {
        name: 'mock',
        summary: 'mock contract for tests',
        input: z.object({ path: z.string().min(1), n: z.number().int().positive() }),
        sideEffects: ['read'],
        riskLevel: 'safe',
        exampleCalls: [{ description: 'ex', args: { path: '/tmp/x', n: 1 } }],
    };

    it('returns the parsed args on valid input', () => {
        const parsed = validateToolCall(contract, { path: '/tmp/y', n: 7 });
        expect(parsed).toEqual({ path: '/tmp/y', n: 7 });
    });

    it('throws ToolValidationError on missing required field', () => {
        expect(() => validateToolCall(contract, { path: '/tmp/y' })).toThrow(ToolValidationError);
    });

    it('throws ToolValidationError on type mismatch', () => {
        expect(() => validateToolCall(contract, { path: '/tmp/y', n: 'seven' })).toThrow(ToolValidationError);
    });

    it('throws ToolValidationError on empty required string', () => {
        expect(() => validateToolCall(contract, { path: '', n: 1 })).toThrow(ToolValidationError);
    });

    it('the error message names the tool + lists issues', () => {
        try {
            validateToolCall(contract, { path: '', n: -1 });
            expect.fail('should have thrown');
        } catch (e) {
            const err = e as ToolValidationError;
            expect(err.toolName).toBe('mock');
            expect(err.issues.length).toBeGreaterThan(0);
            expect(err.message).toContain('mock');
        }
    });

    it('formatValidationError produces a multi-line LLM-friendly string', () => {
        try {
            validateToolCall(contract, {});
            expect.fail('should have thrown');
        } catch (e) {
            const formatted = formatValidationError(e as ToolValidationError);
            expect(formatted).toMatch(/Tool "mock" rejected/);
            expect(formatted).toMatch(/path/);
            expect(formatted).toMatch(/n/);
            expect(formatted.split('\n').length).toBeGreaterThan(2);
        }
    });
});

/* ──────────────────────────  Registry  ────────────────────────── */

describe('Contract registry', () => {
    beforeEach(() => clearToolContracts());

    it('register + lookup round-trips by name', () => {
        const c: ToolContract<{ x: string }, string> = {
            name: 'rt-1',
            summary: 'rt',
            input: z.object({ x: z.string() }),
            sideEffects: ['read'],
            riskLevel: 'safe',
            exampleCalls: [{ description: 'ex', args: { x: 'a' } }],
        };
        registerToolContract(c);
        expect(getToolContract('rt-1')?.name).toBe('rt-1');
        expect(getToolContract('not-there')).toBeUndefined();
    });

    it('listToolContracts returns every registered entry', () => {
        registerToolContract({
            name: 'a',
            summary: 's',
            input: z.object({}),
            sideEffects: ['read'],
            riskLevel: 'safe',
            exampleCalls: [{ description: 'ex', args: {} }],
        });
        registerToolContract({
            name: 'b',
            summary: 's',
            input: z.object({}),
            sideEffects: ['read'],
            riskLevel: 'safe',
            exampleCalls: [{ description: 'ex', args: {} }],
        });
        const all = listToolContracts();
        expect(all.map(c => c.name).sort()).toEqual(['a', 'b']);
    });

    it('register replaces an existing entry under the same name (idempotent)', () => {
        registerToolContract({
            name: 'dup',
            summary: 'first',
            input: z.object({}),
            sideEffects: ['read'],
            riskLevel: 'safe',
            exampleCalls: [{ description: 'ex', args: {} }],
        });
        registerToolContract({
            name: 'dup',
            summary: 'second',
            input: z.object({}),
            sideEffects: ['read'],
            riskLevel: 'safe',
            exampleCalls: [{ description: 'ex', args: {} }],
        });
        expect(getToolContract('dup')?.summary).toBe('second');
    });
});

/* ──────────────────────────  Canonical contracts  ────────────────────────── */

describe('Canonical contracts', () => {
    beforeEach(() => {
        clearToolContracts();
        registerCanonicalContracts();
    });

    const EXPECTED_NAMES = [
        'write_file', 'read_file', 'edit_file', 'append_file', 'list_dir',
        'web_search', 'web_fetch', 'download_image', 'shell',
    ];

    it.each(EXPECTED_NAMES)('contract for %s is registered', (name) => {
        const c = getToolContract(name);
        expect(c).toBeDefined();
        expect(c!.name).toBe(name);
    });

    it.each(listCanonicalContracts())('contract "$name" has a non-empty summary', (contract) => {
        expect(contract.summary.length).toBeGreaterThan(10);
    });

    it.each(listCanonicalContracts())('contract "$name" has at least one exampleCall', (contract) => {
        expect(contract.exampleCalls.length).toBeGreaterThan(0);
    });

    it.each(listCanonicalContracts())(
        'every exampleCall for "$name" validates against its own input schema',
        (contract) => {
            // This is the key invariant: changing a schema without updating
            // the examples should fail loudly. The examples are also the
            // positive samples the auto-mode classifier reads in D.4.
            for (const ex of contract.exampleCalls) {
                const result = contract.input.safeParse(ex.args);
                if (!result.success) {
                    throw new Error(
                        `${contract.name} example "${ex.description}" failed schema: ${
                            result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
                        }`,
                    );
                }
            }
        },
    );

    it('shell contract has riskLevel=high (D.4 will gate it on approval)', () => {
        expect(getToolContract('shell')?.riskLevel).toBe('high');
    });

    it('shell contract has destructive sideEffect', () => {
        expect(getToolContract('shell')?.sideEffects).toContain('destructive');
    });

    it('read-only contracts have riskLevel=safe', () => {
        expect(getToolContract('read_file')?.riskLevel).toBe('safe');
        expect(getToolContract('list_dir')?.riskLevel).toBe('safe');
    });

    // beta.17 (Codex P1 #2): writes mutate user state. Even when the
    // path guard restricts to home + /tmp, a wrong overwrite is not
    // recoverable for non-versioned files. Until path-aware
    // classification ships, writes stay 'moderate' so auto-mode
    // notifies on every call rather than silently fully auto-running.
    it('write contracts have riskLevel=moderate (not safe — bumped in beta.17)', () => {
        expect(getToolContract('write_file')?.riskLevel).toBe('moderate');
        expect(getToolContract('edit_file')?.riskLevel).toBe('moderate');
        expect(getToolContract('append_file')?.riskLevel).toBe('moderate');
    });

    it('network contracts have riskLevel=moderate', () => {
        expect(getToolContract('web_search')?.riskLevel).toBe('moderate');
        expect(getToolContract('web_fetch')?.riskLevel).toBe('moderate');
        expect(getToolContract('download_image')?.riskLevel).toBe('moderate');
    });

    /* Smoke-test that the actual validation catches real LLM mistakes. */

    it('write_file rejects a missing path', () => {
        const c = getToolContract('write_file')!;
        expect(() => validateToolCall(c, { content: 'x' })).toThrow(ToolValidationError);
    });

    it('web_fetch rejects a non-URL string', () => {
        const c = getToolContract('web_fetch')!;
        expect(() => validateToolCall(c, { url: 'not a url at all' })).toThrow(ToolValidationError);
    });

    it('shell rejects an empty command', () => {
        const c = getToolContract('shell')!;
        expect(() => validateToolCall(c, { command: '' })).toThrow(ToolValidationError);
    });

    // beta.17 (Codex P1): field name corrected from numResults → maxResults
    // to match the actual web_search.ts skill registration. Old name was
    // being silently stripped by Zod, losing the caller's count preference.
    it('web_search accepts a valid query and optional maxResults', () => {
        const c = getToolContract('web_search')!;
        expect(() => validateToolCall(c, { query: 'TypeScript' })).not.toThrow();
        expect(() => validateToolCall(c, { query: 'TypeScript', maxResults: 10 })).not.toThrow();
    });

    it('web_search rejects maxResults above 50', () => {
        const c = getToolContract('web_search')!;
        expect(() => validateToolCall(c, { query: 'x', maxResults: 1000 })).toThrow(ToolValidationError);
    });

    // beta.17 regression: contracts use .passthrough() so unknown keys
    // are PRESERVED (forward-compat) rather than silently stripped. This
    // is what lets a future skill add a parameter without breaking the
    // contract day-zero.
    it('web_search preserves unknown keys via .passthrough()', () => {
        const c = getToolContract('web_search')!;
        const parsed = validateToolCall(c, { query: 'x', futureExtra: 'preserved' }) as Record<string, unknown>;
        expect(parsed.futureExtra).toBe('preserved');
    });

    // beta.17 regression: web_fetch field names match the actual skill.
    // The skill takes {url, extractMode, maxChars} — not {url, method, headers, body}.
    it('web_fetch accepts extractMode + maxChars (the actual skill shape)', () => {
        const c = getToolContract('web_fetch')!;
        expect(() => validateToolCall(c, {
            url: 'https://example.com',
            extractMode: 'text',
            maxChars: 5000,
        })).not.toThrow();
    });

    it('web_fetch rejects an invalid extractMode enum value', () => {
        const c = getToolContract('web_fetch')!;
        expect(() => validateToolCall(c, {
            url: 'https://example.com',
            extractMode: 'pdf-export',
        })).toThrow(ToolValidationError);
    });

    // beta.17 regression: shell field names match the actual skill.
    // The skill takes {command, cwd, timeout, background, verify_port} —
    // not {command, cwd, timeoutMs}.
    it('shell accepts background + verify_port for dev-server launches', () => {
        const c = getToolContract('shell')!;
        expect(() => validateToolCall(c, {
            command: 'npm run dev',
            background: true,
            verify_port: 3000,
        })).not.toThrow();
    });

    it('shell uses "timeout" (not "timeoutMs") for the timeout parameter', () => {
        const c = getToolContract('shell')!;
        expect(() => validateToolCall(c, { command: 'sleep 1', timeout: 5000 })).not.toThrow();
        // verify_port out of range still rejects
        expect(() => validateToolCall(c, { command: 'sleep 1', verify_port: 999999 })).toThrow(ToolValidationError);
    });
});
