/**
 * TITAN — Changelog Generator Skill (Built-in)
 * Auto-generates release notes and changelogs from git history.
 * Comparable to OpenHands auto-doc generation.
 */
import { registerSkill } from '../registry.js';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';

const COMPONENT = 'ChangelogGen';

export function registerChangelogGenSkill(): void {
    registerSkill(
        { name: 'generate_changelog', description: 'Generate changelog from git history', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'generate_changelog',
            description: 'Generate a changelog or release notes from git commit history.\n\nUSE THIS WHEN: "generate changelog", "what changed since last release", "write release notes", "summarize recent commits"',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Git repo directory (defaults to cwd)' },
                    since: { type: 'string', description: 'Start ref — tag, commit, or date (e.g. "v1.0.0", "2026-04-01")' },
                    until: { type: 'string', description: 'End ref (default: HEAD)' },
                    format: { type: 'string', description: 'Output format: "grouped" (by type) or "list" (chronological)', enum: ['grouped', 'list'] },
                },
                required: [],
            },
            execute: async (args) => {
                const dir = (args.path as string) || process.cwd();
                const since = args.since as string || '';
                const until = args.until as string || 'HEAD';
                const format = (args.format as string) || 'grouped';

                try {
                    const range = since ? `${since}..${until}` : `-50`;
                    const log = execSync(
                        `git log ${range} --pretty=format:"%h|%s|%an|%as" --no-merges`,
                        { cwd: dir, timeout: 10000 }
                    ).toString().trim();

                    if (!log) return 'No commits found in the specified range.';

                    const commits = log.split('\n').map(line => {
                        const [hash, subject, author, date] = line.split('|');
                        return { hash, subject, author, date };
                    });

                    if (format === 'list') {
                        return commits.map(c => `- ${c.hash} ${c.subject} (${c.author}, ${c.date})`).join('\n');
                    }

                    // Grouped format — categorize by conventional commit prefix
                    const groups: Record<string, typeof commits> = {
                        'Features': [],
                        'Fixes': [],
                        'Performance': [],
                        'Documentation': [],
                        'Other': [],
                    };

                    for (const c of commits) {
                        const s = c.subject.toLowerCase();
                        if (s.startsWith('feat')) groups['Features'].push(c);
                        else if (s.startsWith('fix')) groups['Fixes'].push(c);
                        else if (s.startsWith('perf')) groups['Performance'].push(c);
                        else if (s.startsWith('doc')) groups['Documentation'].push(c);
                        else groups['Other'].push(c);
                    }

                    const lines: string[] = [`# Changelog (${commits.length} commits)`, ''];
                    for (const [group, items] of Object.entries(groups)) {
                        if (items.length === 0) continue;
                        lines.push(`## ${group}`);
                        for (const c of items) {
                            lines.push(`- ${c.subject} (${c.hash})`);
                        }
                        lines.push('');
                    }

                    // Stats
                    const stat = execSync(
                        `git diff --stat ${since ? since + '..' + until : 'HEAD~' + Math.min(commits.length, 50) + '..HEAD'}`,
                        { cwd: dir, timeout: 10000 }
                    ).toString().trim().split('\n').pop() || '';

                    lines.push('## Stats');
                    lines.push(stat);

                    return lines.join('\n');
                } catch (e) {
                    return `Error generating changelog: ${(e as Error).message}`;
                }
            },
        },
    );

    // PR Summary tool
    registerSkill(
        { name: 'summarize_pr', description: 'Summarize a git branch or PR diff', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'summarize_pr',
            description: 'Summarize the changes in a git branch or PR diff.\n\nUSE THIS WHEN: "summarize this PR", "what changed in this branch", "review these changes"',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Git repo directory' },
                    base: { type: 'string', description: 'Base branch (default: main)' },
                    head: { type: 'string', description: 'Head branch (default: HEAD)' },
                },
                required: [],
            },
            execute: async (args) => {
                const dir = (args.path as string) || process.cwd();
                const base = (args.base as string) || 'main';
                const head = (args.head as string) || 'HEAD';

                try {
                    const diffStat = execSync(`git diff --stat ${base}...${head}`, { cwd: dir, timeout: 10000 }).toString();
                    const commits = execSync(`git log ${base}...${head} --oneline --no-merges`, { cwd: dir, timeout: 10000 }).toString();
                    const diff = execSync(`git diff ${base}...${head} --no-color`, { cwd: dir, timeout: 30000 }).toString();

                    const lines = [
                        `## PR Summary: ${base} → ${head}`,
                        '',
                        '### Files Changed',
                        diffStat,
                        '### Commits',
                        commits,
                        '### Diff Preview (first 3000 chars)',
                        diff.slice(0, 3000),
                    ];

                    return lines.join('\n');
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
        },
    );
}
