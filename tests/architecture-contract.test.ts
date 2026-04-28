/**
 * Architecture contract — tests/architecture-contract.test.ts
 *
 * Encoded in `docs/AGENT-HIERARCHY.md`. The doc describes a 3-layer agent
 * hierarchy (loop / delegation / autonomy + governance overlay) and a
 * 6-subdir contract for `src/agent/`. The contract itself is enforced
 * here so it doesn't decay into a doc-only convention.
 *
 * What this test guards against:
 *
 *   1. Re-introduction of duplicate sub-agent spawn paths. v5.4.x
 *      consolidated three:
 *        - swarm.runSubAgent — was its own chat()+executeTools() mini-loop;
 *          now a shim over spawnSubAgent.
 *        - structuredSpawn.structuredSpawn — kept (it's a JSON-tail wrapper,
 *          not a parallel implementation; it calls spawnSubAgent internally).
 *        - orchestrator inline chat() with 'You are X' system prompts —
 *          banned.
 *      The single canonical spawn point is `spawnSubAgent` in
 *      `src/agent/subAgent.ts`.
 *
 *   2. Inline specialist system prompts outside `delegation/specialists.ts`.
 *      Catches the "I'll just do a quick chat({ systemPrompt: 'You are an
 *      explorer...' })" pattern that's how parallel spawn paths used to
 *      sneak back in.
 *
 *   3. Fragmented swarm-style mini-loops: any new file in src/agent/ that
 *      runs its own chat()+executeTools()+round-counter loop bypassing
 *      spawnSubAgent. This is the "I'll just add another orchestrator"
 *      regression that the cleanup pass eliminated.
 *
 * Note: the 6-subdirectory file-organization contract from AGENT-HIERARCHY.md
 * (loop/delegation/autonomy/governance/self-mod/tooling) is NOT enforced
 * here yet — that reorg is queued as a dedicated worktree task because
 * it touches 100+ files. When it lands, add a directory check to this
 * suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const AGENT_DIR = join(REPO_ROOT, 'src/agent');

function listAgentFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            // Skip noisy subdirs (adapters/ has third-party shims with
            // legitimate inline prompts; tests/ has fixtures).
            if (entry === 'adapters') continue;
            out.push(...listAgentFiles(full));
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

const AGENT_FILES = listAgentFiles(AGENT_DIR);

describe('architecture contract — sub-agent spawn discipline', () => {
    it('only swarm.ts re-exports / wraps runSubAgent; nothing else defines it', () => {
        // Any file declaring its own `function runSubAgent` or
        // `const runSubAgent =` is suspect — likely a parallel mini-loop
        // sneaking back in. Only swarm.ts is allowed (the shim entry
        // point).
        const offenders: string[] = [];
        for (const file of AGENT_FILES) {
            if (file.endsWith('/swarm.ts')) continue;
            const src = readFileSync(file, 'utf8');
            const declares = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+runSubAgent\b|(?:^|\n)\s*(?:export\s+)?const\s+runSubAgent\s*=/m;
            if (declares.test(src)) {
                offenders.push(file.replace(REPO_ROOT + '/', ''));
            }
        }
        expect(offenders, `Files declaring their own runSubAgent (only swarm.ts may): ${offenders.join(', ')}`).toEqual([]);
    });

    it('inline "You are a/an X" specialist prompts only live in the canonical specialist registry', () => {
        // The pattern that breeds parallel spawn paths: someone writes
        //   chat({ messages: [{ role: 'system', content: 'You are an
        //   explorer agent...' }, ...] })
        // bypassing the specialist registry, governance overlay, and
        // trace bus. The legitimate home for these strings is exactly
        // `delegation/specialists.ts` (post-Phase-C) or
        // `agent/specialists.ts` (pre-reorg).
        const ALLOWED = new Set([
            'src/agent/specialists.ts',
            'src/agent/specialistRouter.ts', // routes to the registry
            'src/agent/structuredSpawn.ts',  // composes with specialists.systemPromptSuffix
            'src/agent/subAgent.ts',         // canonical SUB_AGENT_TEMPLATES live here pre-Phase-C
        ]);
        // Catch sub-agent-style spawn prompts that bypass the registry.
        // Specifically: "You are the [Role] sub-agent" / "You are a/an [Role]
        // agent" / "You are the [Role] Sub-Agent". Generic prompts ("You are
        // a careful autonomous agent proposing new work" in goalProposer.ts,
        // "You are a concise task progress assessor" in reflection.ts) are
        // legitimate chat() callers for their own domain — they don't claim
        // to be a sub-agent and don't compete with spawnSubAgent.
        const inlinePromptPattern = /['"`]You are (?:an?|the)\s+\w+\s+(?:sub-?agent|agent\b|Sub-Agent)/i;

        const offenders: string[] = [];
        for (const file of AGENT_FILES) {
            const rel = file.replace(REPO_ROOT + '/', '');
            if (ALLOWED.has(rel)) continue;
            const src = readFileSync(file, 'utf8');
            // Strip line/block comments before matching so "// You are an
            // explorer" in a doc comment doesn't trigger a false positive.
            const stripped = src
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:])\/\/.*$/gm, '$1');
            if (inlinePromptPattern.test(stripped)) {
                offenders.push(rel);
            }
        }
        expect(offenders, `Inline specialist prompts found outside the registry: ${offenders.join(', ')}`).toEqual([]);
    });

    it('no file outside swarm.ts/subAgent.ts runs a chat()+executeTools() mini-loop', () => {
        // The canonical agent loop lives in `agentLoop.ts` (the per-turn
        // user-facing loop) and `subAgent.ts` (sub-agent loop). `swarm.ts`
        // historically had a third one but is now a shim (kept exempt as
        // a re-export point in case the shim ever needs to compose).
        // Anything else hosting both `chat(` and `executeTools(` in the
        // same file with a `for/while` loop nearby is suspect.
        const ALLOWED = new Set([
            'src/agent/agentLoop.ts',
            'src/agent/subAgent.ts',
            'src/agent/agent.ts',          // top-level coordinator
            'src/agent/agentWakeup.ts',    // scheduled-wake driver
            'src/agent/multiAgent.ts',     // channel router
            'src/agent/parallelTools.ts',  // tool-level parallelism, not agent loop
            'src/agent/swarm.ts',          // shim — kept allowlisted in case future composition lands
            'src/agent/orchestrator.ts',   // delegation analyzer; legitimately calls executeTools sometimes
            'src/agent/peerAdvise.ts',     // peer-advise pattern
            'src/agent/verifier.ts',       // self-verification loop
        ]);
        const offenders: string[] = [];
        for (const file of AGENT_FILES) {
            const rel = file.replace(REPO_ROOT + '/', '');
            if (ALLOWED.has(rel)) continue;
            const src = readFileSync(file, 'utf8');
            // Must call both primitives AND have a loop construct in the
            // same file. Either alone is fine (helper modules, parsers,
            // etc.).
            const callsChat = /\bchat\s*\(/.test(src);
            const callsExecuteTools = /\bexecuteTools\s*\(/.test(src);
            const hasLoop = /\b(?:for|while)\s*\(/.test(src);
            if (callsChat && callsExecuteTools && hasLoop) {
                offenders.push(rel);
            }
        }
        expect(offenders, `Files appearing to host their own chat+executeTools+loop (likely a parallel agent loop): ${offenders.join(', ')}`).toEqual([]);
    });
});

describe('architecture contract — sub-agent canonical entry', () => {
    it('exactly one definition of `export async function spawnSubAgent` exists', () => {
        // Sanity check that the canonical primitive isn't accidentally
        // shadowed by a duplicate export.
        let hits = 0;
        for (const file of AGENT_FILES) {
            const src = readFileSync(file, 'utf8');
            const matches = src.match(/export\s+async\s+function\s+spawnSubAgent\b/g);
            if (matches) hits += matches.length;
        }
        expect(hits).toBe(1);
    });
});
