import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 30000,
        hookTimeout: 25000,
        pool: 'forks',
        poolOptions: {
            forks: {
                maxForks: process.env.CI ? 1 : undefined,
                minForks: 1,
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
