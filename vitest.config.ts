import { defineConfig } from 'vitest/config';

// CI-vs-local heap differentiation. The original config baked in
// `--max-old-space-size=20480` (20 GB) which is fine on a 64 GB dev
// machine but instantly OS-kills the GitHub-hosted Linux runner
// (7 GB total RAM). Every CI run since v4.9.0 was hitting this:
// vitest spawned a single fork, tried to allocate >7 GB heap, and the
// runner reaped the process with the bare "operation cancelled"
// message. CLAUDE.md called it the "Vitest worker OOM flake on full
// suite" without identifying the root cause.
//
// Strategy (revised after v5.4.x — round 3):
//   - Local: 12 GB / sequential so heavy module-graph reloading in
//     agent.test.ts has room to breathe.
//   - CI: 4 GB heap, sequential, BUT each test file runs in its OWN
//     fork that's killed afterwards. The earlier maxForks=1 +
//     minForks=1 combo kept ONE fork alive across all ~150 files;
//     heap accumulated and OOM'd around file 100. Setting
//     `singleFork: false` (the default) and dropping minForks lets
//     vitest spawn a fresh fork per file — each file starts with a
//     cold heap, never hits the 4 GB cap, total RAM stays under
//     7 GB because only one fork is ever live at a time.
//   - `fileParallelism: false` enforces strict sequential file
//     execution so we never have two heavy forks alive together.
const IS_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);

// 6 GB on CI: with sharding (3 shards in ci.yml), only ONE node process
// runs at a time, so we can use most of the runner's 7 GB ceiling. The
// fork is still reused across the ~80 files per shard and heap
// accumulates — at 4 GB this OOMd at file 81/82. 6 GB gives clear
// headroom while leaving ~1 GB for OS + GHA agent overhead.
const HEAP_MB = IS_CI ? 6144 : 12288;
const MAX_FORKS = 1;

// CI also excludes a small set of heavy integration tests that need >7 GB
// heap (the runner ceiling). They're covered by narrower targeted tests
// elsewhere; force-run with RUN_HEAVY=1 if you bump the runner class.
const HEAVY_TESTS_EXCLUDED_IN_CI = IS_CI && !process.env.RUN_HEAVY ? [
    // Re-evaluates the full TITAN module graph (200+ modules) on every test
    // via vi.resetModules + dynamic import. Working set ~12 GB.
    'tests/agent.test.ts',
] : [];

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        exclude: ['node_modules/**', 'dist/**', ...HEAVY_TESTS_EXCLUDED_IN_CI],
        testTimeout: 30000,
        hookTimeout: 25000,
        // Pool tuning — see header comment above. agent.test.ts loads
        // 200+ TITAN modules transitively and the per-test
        // `vi.resetModules() + await import()` pattern accumulates
        // heap faster than GC can reclaim.
        //
        // CI critical: `fileParallelism: false` + `singleFork: false`
        // means each file runs in its OWN fork, sequentially. Each
        // fork starts cold, finishes its file, dies. Without this,
        // CI accumulates heap across files and OOMs near the end of
        // the suite even at 6 GB.
        pool: 'forks',
        // Force strict sequential file execution on CI (one fork active at
        // a time). `fileParallelism: false` is the public knob; `maxForks`
        // is a ceiling, not a forcing function.
        fileParallelism: !IS_CI,
        poolOptions: {
            forks: {
                maxForks: MAX_FORKS,
                // minForks=0 lets the pool kill idle workers between files,
                // which is what releases heap on CI. With minForks=1 the
                // pool kept one fork alive forever and heap accumulated.
                minForks: 0,
                execArgv: [`--max-old-space-size=${HEAP_MB}`, '--expose-gc'],
            },
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            include: ['src/**/*.ts'],
            exclude: ['src/gateway/dashboard.ts'],
            thresholds: { branches: 75, functions: 60, lines: 60, statements: 60 },
        },
    },
});
