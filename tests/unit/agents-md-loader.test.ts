/**
 * Hierarchical AGENTS.md loader — unit tests.
 *
 * The agents.md spec (https://agents.md) and Space Agent's L0/L1/L2 pattern
 * agree: project-local agent instructions should be discoverable by walking
 * UP from the file the agent is working on, concatenated with the nearest
 * file taking precedence. Convention-compatible with Claude Code, Cursor,
 * OpenCode, and Codex CLI.
 *
 * Additional rule from HumanLayer's "Skill Issue: Harness Engineering for
 * Coding Agents": AGENTS.md files past ~60 lines hurt more than they help.
 * We enforce the cap defensively at load time so a long file doesn't crowd
 * out everything else in the prompt budget.
 *
 * Reference:
 *   - https://agents.md — closest-file-wins spec
 *   - https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents
 *   - awesome-agent-harness top-10 pattern: "AGENTS.md — repo-local agent directives"
 *   - Space Agent L0/L1/L2 pattern
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    loadAgentsHierarchy,
    type AgentsFile,
    type AgentsHierarchyResult,
} from '../../src/agent/agentsMdLoader.js';

let TMP: string;

beforeEach(() => {
    TMP = join(tmpdir(), `agents-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

function write(relPath: string, content: string): string {
    const full = join(TMP, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    return full;
}

describe('loadAgentsHierarchy — basics', () => {
    it('returns empty result when no AGENTS.md exists anywhere', () => {
        const r = loadAgentsHierarchy({ rootPath: TMP });
        expect(r.files).toEqual([]);
        expect(r.totalLines).toBe(0);
        expect(r.truncated).toBe(false);
    });

    it('loads a single project-root AGENTS.md (L0)', () => {
        write('AGENTS.md', '# Project rules\n- Use snake_case\n- TDD always');
        const r = loadAgentsHierarchy({ rootPath: TMP });
        expect(r.files).toHaveLength(1);
        expect(r.files[0].path).toMatch(/AGENTS\.md$/);
        expect(r.files[0].content).toContain('snake_case');
        expect(r.files[0].depth).toBe(0);
    });

    it('walks up from a deep target path collecting every AGENTS.md along the way', () => {
        write('AGENTS.md', '# L0 root rules');
        write('src/AGENTS.md', '# L1 src rules');
        write('src/skills/AGENTS.md', '# L2 skills rules');
        const target = write('src/skills/foo.ts', '// hi');

        const r = loadAgentsHierarchy({ rootPath: TMP, targetPath: target });
        expect(r.files).toHaveLength(3);
        // Order: root first, deepest last (so the deepest wins on conflict
        // since concat puts the most recent at the bottom and the LLM weights
        // recency under U-shaped attention).
        expect(r.files[0].content).toContain('L0 root rules');
        expect(r.files[1].content).toContain('L1 src rules');
        expect(r.files[2].content).toContain('L2 skills rules');
        expect(r.files[0].depth).toBe(0);
        expect(r.files[2].depth).toBe(2);
    });

    it('without a target path, walks the rootPath subtree shallowly (root + 1 level)', () => {
        write('AGENTS.md', '# root');
        write('src/AGENTS.md', '# src');
        write('src/deep/AGENTS.md', '# deep'); // outside the shallow walk
        const r = loadAgentsHierarchy({ rootPath: TMP });
        // Should include root and src, NOT deep — shallow walk by design.
        const paths = r.files.map(f => f.path);
        expect(paths.some(p => p.endsWith('/AGENTS.md') && !p.includes('/src/'))).toBe(true);
        expect(paths.some(p => p.includes('/src/AGENTS.md'))).toBe(true);
        expect(paths.some(p => p.includes('/deep/'))).toBe(false);
    });
});

describe('loadAgentsHierarchy — 60-line cap (HumanLayer rule)', () => {
    it('truncates a single file over the maxLinesPerFile cap with a marker', () => {
        const longContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
        write('AGENTS.md', longContent);
        const r = loadAgentsHierarchy({ rootPath: TMP, maxLinesPerFile: 60 });
        expect(r.files).toHaveLength(1);
        const f = r.files[0];
        const lines = f.content.split('\n');
        // 60 content lines + 1 truncation marker
        expect(lines.length).toBeLessThanOrEqual(62);
        expect(f.content).toMatch(/truncated.*200 lines/);
        expect(f.truncated).toBe(true);
        expect(r.truncated).toBe(true);
    });

    it('does NOT truncate files under the cap', () => {
        const content = '# Short rules\n- One\n- Two';
        write('AGENTS.md', content);
        const r = loadAgentsHierarchy({ rootPath: TMP, maxLinesPerFile: 60 });
        expect(r.files[0].content).toBe(content);
        expect(r.files[0].truncated).toBe(false);
    });

    it('default cap is 60 (per HumanLayer guidance)', () => {
        const longContent = Array.from({ length: 100 }, (_, i) => `rule ${i + 1}`).join('\n');
        write('AGENTS.md', longContent);
        const r = loadAgentsHierarchy({ rootPath: TMP });
        expect(r.files[0].truncated).toBe(true);
        // Default cap is 60 — content should be 60 lines plus the marker
        const lines = r.files[0].content.split('\n');
        expect(lines.length).toBeLessThanOrEqual(62);
    });
});

describe('loadAgentsHierarchy — security & robustness', () => {
    it('refuses files larger than maxBytesPerFile (default 100 KB)', () => {
        const huge = 'x'.repeat(200_000);
        write('AGENTS.md', huge);
        const r = loadAgentsHierarchy({ rootPath: TMP, maxBytesPerFile: 100_000 });
        // File is rejected entirely with a placeholder rather than parsed
        expect(r.files[0].content).toMatch(/skipped.*too large/i);
        expect(r.files[0].truncated).toBe(true);
    });

    it('never walks above rootPath (path traversal guard)', () => {
        // Even if targetPath points to ../../something outside root, we don't
        // load anything from there.
        write('AGENTS.md', '# inside root');
        const targetOutsideRoot = '/etc/passwd';
        const r = loadAgentsHierarchy({ rootPath: TMP, targetPath: targetOutsideRoot });
        // Should still return only the AGENTS.md inside TMP, none from /etc.
        expect(r.files).toHaveLength(1);
        for (const f of r.files) {
            expect(f.path.startsWith(TMP)).toBe(true);
        }
    });

    it('total budget caps prevent runaway loading', () => {
        // Many AGENTS.md files in the hierarchy; total should respect budget.
        write('AGENTS.md', 'a'.repeat(2000));
        write('a/AGENTS.md', 'b'.repeat(2000));
        write('a/b/AGENTS.md', 'c'.repeat(2000));
        write('a/b/c/AGENTS.md', 'd'.repeat(2000));
        const target = write('a/b/c/file.txt', '// hi');

        const r = loadAgentsHierarchy({ rootPath: TMP, targetPath: target, maxTotalBytes: 5000 });
        const total = r.files.reduce((n, f) => n + f.content.length, 0);
        expect(total, `total ${total} should not exceed maxTotalBytes 5000`).toBeLessThanOrEqual(5000);
        expect(r.truncated).toBe(true);
    });

    it('handles a missing rootPath gracefully', () => {
        const r = loadAgentsHierarchy({ rootPath: join(TMP, 'does-not-exist') });
        expect(r.files).toEqual([]);
        expect(r.totalLines).toBe(0);
    });
});

describe('loadAgentsHierarchy — formatting', () => {
    it('each AgentsFile entry has a stable shape for downstream injection', () => {
        write('AGENTS.md', '# rules');
        const r: AgentsHierarchyResult = loadAgentsHierarchy({ rootPath: TMP });
        const f: AgentsFile = r.files[0];
        expect(typeof f.path).toBe('string');
        expect(typeof f.content).toBe('string');
        expect(typeof f.depth).toBe('number');
        expect(typeof f.truncated).toBe('boolean');
    });
});
