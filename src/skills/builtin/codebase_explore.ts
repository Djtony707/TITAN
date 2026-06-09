/**
 * TITAN — Codebase Exploration Skill (v7.0, beats the operator-shell repo map)
 *
 * Active, iterative repo understanding: walk the tree, classify languages,
 * locate entrypoints + key files, and produce a structured map the agent can
 * reason over BEFORE touching code — instead of relying on a stale static index.
 *
 * `exploreCodebase()` is a pure-ish function (reads fs, no globals) exported for
 * tests. The `codebase_explore` tool wraps it for the agent.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'CodebaseExplore';

/** Directories that are never source — skipped during the walk. */
const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
    'vendor', '__pycache__', '.venv', 'venv', '.cache', 'target', '.turbo',
    '.idea', '.vscode', 'tmp', '.pytest_cache', 'ui/dist', '.gitnexus',
]);

/** Extension → language label. */
const LANG_BY_EXT: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript/React', '.js': 'JavaScript', '.jsx': 'JavaScript/React',
    '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
    '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++',
    '.cs': 'C#', '.swift': 'Swift', '.kt': 'Kotlin', '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell',
    '.sql': 'SQL', '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
    '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
};

/** Files that signal a project's shape. */
const KEY_FILES: Array<{ match: RegExp; kind: string }> = [
    { match: /^package\.json$/, kind: 'Node manifest' },
    { match: /^pyproject\.toml$|^setup\.py$|^requirements\.txt$/, kind: 'Python manifest' },
    { match: /^go\.mod$/, kind: 'Go module' },
    { match: /^Cargo\.toml$/, kind: 'Rust crate' },
    { match: /^pom\.xml$|^build\.gradle$/, kind: 'JVM build' },
    { match: /^Gemfile$/, kind: 'Ruby bundle' },
    { match: /^composer\.json$/, kind: 'PHP composer' },
    { match: /^Dockerfile$|^docker-compose\.ya?ml$/, kind: 'container' },
    { match: /^readme(\.md)?$/i, kind: 'README' },
    { match: /^tsconfig\.json$/, kind: 'TS config' },
    { match: /^\.env(\.example)?$/, kind: 'env template' },
];

export interface CodebaseMap {
    root: string;
    fileCount: number;
    dirCount: number;
    /** Language label → file count, descending. */
    languages: Record<string, number>;
    /** Likely program entrypoints (relative paths). */
    entrypoints: string[];
    /** Project-shape files (manifests, README, configs). */
    keyFiles: Array<{ path: string; kind: string }>;
    /** Largest source directories by file count. */
    topDirs: Array<{ dir: string; files: number }>;
    /** Whether the walk hit the file cap. */
    truncated: boolean;
}

interface ExploreOpts {
    maxDepth?: number;   // default 6
    maxFiles?: number;   // default 4000 — keeps a huge monorepo bounded
}

/** Walk + analyze a codebase rooted at `root`. Pure aside from fs reads. */
export function exploreCodebase(root: string, opts: ExploreOpts = {}): CodebaseMap {
    const maxDepth = opts.maxDepth ?? 6;
    const maxFiles = opts.maxFiles ?? 4000;
    const languages: Record<string, number> = {};
    const keyFiles: CodebaseMap['keyFiles'] = [];
    const dirFileCounts = new Map<string, number>();
    let fileCount = 0;
    let dirCount = 0;
    let truncated = false;

    function walk(dir: string, depth: number): void {
        if (depth > maxDepth || truncated) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
            if (name.startsWith('.') && name !== '.env' && name !== '.env.example') {
                if (IGNORED_DIRS.has(name)) continue;
            }
            const full = join(dir, name);
            let st;
            try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) {
                if (IGNORED_DIRS.has(name)) continue;
                dirCount++;
                walk(full, depth + 1);
            } else if (st.isFile()) {
                if (fileCount >= maxFiles) { truncated = true; return; }
                fileCount++;
                const rel = relative(root, full);
                const ext = extname(name).toLowerCase();
                const lang = LANG_BY_EXT[ext];
                if (lang) languages[lang] = (languages[lang] || 0) + 1;
                // track per-top-dir file counts
                const topDir = rel.includes('/') ? rel.split('/')[0] : '.';
                dirFileCounts.set(topDir, (dirFileCounts.get(topDir) || 0) + 1);
                // key files
                for (const kf of KEY_FILES) {
                    if (kf.match.test(name)) { keyFiles.push({ path: rel, kind: kf.kind }); break; }
                }
            }
        }
    }
    walk(root, 0);

    // Resolve entrypoints from manifests + conventional files.
    const entrypoints = resolveEntrypoints(root);

    const topDirs = [...dirFileCounts.entries()]
        .filter(([d]) => d !== '.')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([dir, files]) => ({ dir, files }));

    // Sort languages descending.
    const sortedLangs: Record<string, number> = {};
    for (const [k, v] of Object.entries(languages).sort((a, b) => b[1] - a[1])) sortedLangs[k] = v;

    return { root, fileCount, dirCount, languages: sortedLangs, entrypoints, keyFiles, topDirs, truncated };
}

/** Find likely entrypoints from manifests + conventional file names. */
function resolveEntrypoints(root: string): string[] {
    const found: string[] = [];
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            if (typeof pkg.main === 'string') found.push(pkg.main);
            if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) if (typeof v === 'string') found.push(v);
            else if (typeof pkg.bin === 'string') found.push(pkg.bin);
            const startScript = pkg.scripts?.start as string | undefined;
            if (startScript) {
                const m = startScript.match(/\b([\w./-]+\.(?:js|mjs|cjs|ts))\b/);
                if (m) found.push(m[1]);
            }
        } catch { /* malformed manifest — fall through to conventions */ }
    }
    for (const cand of ['src/index.ts', 'src/index.js', 'src/main.ts', 'index.ts', 'index.js', 'main.py', 'app.py', '__main__.py', 'cmd/main.go', 'main.go', 'src/main.rs']) {
        if (existsSync(join(root, cand))) found.push(cand);
    }
    // de-dup, keep order, cap
    return [...new Set(found.map((f) => f.replace(/^\.\//, '')))].slice(0, 8);
}

/** Render the map as a readable report for the agent. */
export function formatCodebaseMap(m: CodebaseMap): string {
    const lines: string[] = [];
    lines.push(`# Codebase map — ${basename(m.root) || m.root}`);
    lines.push(`${m.fileCount} files across ${m.dirCount} dirs${m.truncated ? ' (truncated at cap)' : ''}`);
    const langs = Object.entries(m.languages).slice(0, 6).map(([l, n]) => `${l} (${n})`).join(', ');
    if (langs) lines.push(`\n**Languages:** ${langs}`);
    if (m.entrypoints.length) lines.push(`\n**Entrypoints:** ${m.entrypoints.join(', ')}`);
    if (m.topDirs.length) lines.push(`\n**Top source dirs:**\n${m.topDirs.map((d) => `- \`${d.dir}/\` — ${d.files} files`).join('\n')}`);
    if (m.keyFiles.length) {
        const shown = m.keyFiles.slice(0, 12);
        lines.push(`\n**Key files:**\n${shown.map((k) => `- \`${k.path}\` — ${k.kind}`).join('\n')}`);
    }
    return lines.join('\n');
}

export function registerCodebaseExploreSkill(): void {
    registerSkill(
        { name: 'codebase_explore', description: 'Map a codebase: languages, entrypoints, key files, structure', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'codebase_explore',
            description:
                'Explore + map a codebase to understand it before working on it. Walks the repo (skipping node_modules/.git/dist/…), classifies languages, finds entrypoints + manifests + key files, and ranks the largest source dirs. Returns a structured map.\n\nUSE THIS WHEN: starting work in an unfamiliar repo, "understand this project", "where is the entrypoint", before a refactor/feature. Pass a path (defaults to the current directory).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory to explore. Defaults to the current working directory.' },
                    maxDepth: { type: 'number', description: 'Max directory depth (default 6).' },
                },
                required: [],
            },
            execute: async (args: Record<string, unknown>): Promise<string> => {
                const path = (args.path as string) || process.cwd();
                if (!existsSync(path)) return `Path not found: ${path}`;
                try {
                    const map = exploreCodebase(path, { maxDepth: args.maxDepth as number | undefined });
                    logger.info(COMPONENT, `Explored ${path}: ${map.fileCount} files, ${Object.keys(map.languages).length} languages`);
                    return formatCodebaseMap(map);
                } catch (e) {
                    return `Codebase exploration failed: ${(e as Error).message}`;
                }
            },
        },
    );
}
