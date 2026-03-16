#!/usr/bin/env node
/**
 * Build personal skills → dist/skills/personal/
 * Only exists on Tony's machine (src/skills/personal/ is gitignored).
 * Run: npm run build:personal
 *
 * Output location: dist/skills/personal/loader.js
 *   Co-located with dist/skills/registry.js so `../registry` resolves to the
 *   SAME module instance as the main TITAN app — tools register correctly.
 *
 * Legacy ~/.titan/personal/ is kept as a fallback for machines without dist/.
 */
const { execSync } = require('child_process');
const { existsSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const personalSrc = join(__dirname, '..', 'src', 'skills', 'personal', 'loader.ts');
const distOutDir  = join(__dirname, '..', 'dist', 'skills', 'personal');
const homeOutDir  = join(homedir(), '.titan', 'personal');

if (!existsSync(personalSrc)) {
    console.log('No personal skills found (src/skills/personal/ is empty or gitignored on this machine).');
    process.exit(0);
}

mkdirSync(distOutDir, { recursive: true });
mkdirSync(homeOutDir, { recursive: true });

console.log(`Building personal skills → ${distOutDir}`);

try {
    // Primary build: output to dist/skills/personal/ with ../registry marked external.
    // This makes the personal loader import registerSkill from the SAME dist/skills/registry.js
    // that the main TITAN app uses — tools register into the correct shared toolRegistry.
    execSync(
        `npx esbuild "${personalSrc}" --bundle --format=esm --platform=node `
        + `--outfile="${join(distOutDir, 'loader.js')}" `
        + `--external:"node:*" --external:"../registry"`,
        { stdio: 'inherit', cwd: join(__dirname, '..') }
    );
    writeFileSync(join(distOutDir, 'package.json'), '{"type":"module"}\n');
    console.log('✓ Personal skills built successfully (dist)');
    console.log(`  Output: ${distOutDir}/loader.js`);
} catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
}
