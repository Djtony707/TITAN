/**
 * tsup config — reproduces the build pipeline from the committed HEAD
 * package.json so we can rebuild `dist/` on the Mac checkout after the
 * repo was reshaped into a pnpm workspace. Run `npx tsup` to use this.
 *
 * The `external` list mirrors Titan PC's deploy expectations — these
 * packages stay unbundled so the remote `node_modules` resolves them
 * at runtime. Do not drop any without updating the deploy guide.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
    // v5.0.0: glob all runtime .ts files so new modules are auto-included.
    // Previously the hardcoded entry list drifted from the codebase and
    // missing files caused `ERR_MODULE_NOT_FOUND` on deploy.
    entry: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/*.test.ts',
        '!src/**/*.spec.ts',
    ],
    format: ['esm'],
    target: 'node20',
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false,
    // Bundling the whole dep graph into 7MB monoliths produces
    // `__filename`/`require` collisions with CJS shims already in the
    // transitive deps. Match the shape of the historical (working)
    // dist/ — 1:1 per-file ESM transpile, relying on Titan PC's
    // node_modules to resolve runtime imports.
    bundle: false,
    external: [
        'playwright',
        'playwright-core',
        'chromium-bidi',
        '@browserbasehq/stagehand',
        '@whiskeysockets/baileys',
        'matrix-js-sdk',
        'pdf-parse',
        'jsdom',
        'node-llama-cpp',
        'undici',
        'bonjour-service',
        // Added during v5.0 Spacewalk deploy — these land inside node_modules
        // on Titan PC and must not be bundled, matching the runtime env.
        'pg',
        'better-sqlite3',
    ],
    banner: {
        js: '#!/usr/bin/env node',
    },
});
