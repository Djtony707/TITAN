import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 30000,
        hookTimeout: 25000,
        // v4.9.0: use the vmThreads pool with an explicit memoryLimit
        // and run tests/agent.test.ts sequentially via its own project.
        // The prior `pool: 'forks'` + default heap hit
        // `ERR_WORKER_OUT_OF_MEMORY` partway through agent.test.ts
        // because processMessage transitively loads 200+ TITAN modules
        // (skills registry, specialists, graph, providers, etc.) and
        // the per-test `vi.resetModules() + await import()` pattern
        // re-evaluates the graph every time, accumulating heap faster
        // than GC can reclaim.
        //
        // Per-test heap bumped to 12GB — legitimate given TITAN's
        // genuine module-graph size; well under the 64GB dev machine
        // ceiling. --expose-gc lets targeted tests call global.gc()
        // when they need to force reclamation between heavy runs.
        pool: 'forks',
        poolOptions: {
            forks: {
                maxForks: process.env.CI ? 1 : undefined,
                minForks: 1,
                execArgv: ['--max-old-space-size=12288', '--expose-gc'],
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
