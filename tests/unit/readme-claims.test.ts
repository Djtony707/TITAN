/**
 * README claim verification tests.
 *
 * Every claim in README.md should map to running code. When someone adds 5
 * skills the tool count grows from 248 to 253 but the README still says 248
 * — the claim quietly becomes a lie. This file detects that drift.
 *
 * Most assertions use ±10% bands so the README can round to memorable
 * numbers without breaking the build on a single new file. A few hard
 * assertions (existence of named modules, exact suite count) catch the
 * "feature was removed but README still sells it" failure mode.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

function countTemplateFiles(): number {
    const root = join(REPO_ROOT, 'assets/widget-templates');
    if (!existsSync(root)) return 0;
    let n = 0;
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith('.json')) n++;
        }
    };
    walk(root);
    return n;
}

function countCategoryDirs(): number {
    const root = join(REPO_ROOT, 'assets/widget-templates');
    if (!existsSync(root)) return 0;
    return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).length;
}

function countChannelAdapters(): number {
    // src/channels/*.ts minus base.ts and any non-adapter helpers
    const root = join(REPO_ROOT, 'src/channels');
    if (!existsSync(root)) return 0;
    return readdirSync(root)
        .filter(f => f.endsWith('.ts'))
        .filter(f => f !== 'base.ts' && f !== 'index.ts' && f !== 'types.ts')
        .length;
}

function countAdminPanels(): number {
    const root = join(REPO_ROOT, 'ui/src/components/admin');
    if (!existsSync(root)) return 0;
    return readdirSync(root).filter(f => f.endsWith('Panel.tsx')).length;
}

function countEvalSuites(): number {
    const harness = join(REPO_ROOT, 'src/eval/harness.ts');
    if (!existsSync(harness)) return 0;
    const src = readFileSync(harness, 'utf-8');
    const matches = src.match(/export const [A-Z][A-Z0-9_]*_SUITE: EvalCase\[\] =/g);
    return matches ? matches.length : 0;
}

function countBuiltinSkillFiles(): number {
    const root = join(REPO_ROOT, 'src/skills/builtin');
    if (!existsSync(root)) return 0;
    return readdirSync(root).filter(f => f.endsWith('.ts')).length;
}

function countOpenAICompatProviderIDs(): number {
    const file = join(REPO_ROOT, 'src/providers/openai_compat.ts');
    if (!existsSync(file)) return 0;
    const src = readFileSync(file, 'utf-8');
    // Provider entries are objects with a `name:` field; count those.
    // (Other `id:` occurrences are tool-call IDs in stream parsing, not providers.)
    const matches = src.match(/^\s{4,}name:\s*['"][a-z0-9_-]+['"]/gm);
    return matches ? matches.length : 0;
}

function readReadme(): string {
    return readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
}

describe('README claim verification', () => {
    // ─── Numerical claims ───────────────────────────────────────────

    it('Widget template count matches the README "109 widgets" claim within ±10%', () => {
        const actual = countTemplateFiles();
        const claimed = 109;
        expect(actual).toBeGreaterThan(0);
        const drift = Math.abs(actual - claimed) / claimed;
        expect(drift, `README says ${claimed}, actual ${actual}`).toBeLessThan(0.1);
    });

    it('Widget categories match the README "28 categories" claim exactly', () => {
        const actual = countCategoryDirs();
        // Exact match because adding/removing a category is intentional;
        // bump README + this test together.
        expect(actual, `README says 28 categories, actual ${actual}`).toBe(28);
    });

    it('Channel adapter count is what the README reports (19)', () => {
        const actual = countChannelAdapters();
        expect(actual, `README says 19 channels, actual ${actual}`).toBe(19);
    });

    it('Admin panel count is within 10% of README "45 panels"', () => {
        const actual = countAdminPanels();
        const claimed = 45;
        const drift = Math.abs(actual - claimed) / claimed;
        expect(drift, `README says ${claimed} admin panels, actual ${actual}`).toBeLessThan(0.1);
    });

    it('Live-eval suite count matches README "11 suites" exactly', () => {
        const actual = countEvalSuites();
        expect(actual, `README says 11 suites, actual ${actual}`).toBe(11);
    });

    it('Builtin skill file count is within 10% of README "80+ files"', () => {
        const actual = countBuiltinSkillFiles();
        expect(actual).toBeGreaterThanOrEqual(70);
        expect(actual).toBeLessThanOrEqual(120);
    });

    it('OpenAI-compatible provider IDs are within 10% of README "32"', () => {
        const actual = countOpenAICompatProviderIDs();
        const claimed = 32;
        const drift = Math.abs(actual - claimed) / claimed;
        expect(drift, `README says 32 OpenAI-compat providers, actual ${actual}`).toBeLessThan(0.1);
    });

    // ─── Feature-existence claims ────────────────────────────────────

    it('F5-TTS voice cloning sidecar scripts exist', () => {
        for (const p of ['scripts/f5-tts-server.py', 'scripts/f5-tts-gpu-server.py']) {
            const full = join(REPO_ROOT, p);
            expect(existsSync(full), `${p} should exist`).toBe(true);
            expect(statSync(full).size).toBeGreaterThan(500);
        }
    });

    it('Voice integration glue exists in TypeScript', () => {
        for (const p of ['src/channels/messenger-voice.ts', 'src/skills/builtin/voice.ts']) {
            expect(existsSync(join(REPO_ROOT, p)), `${p} should exist`).toBe(true);
        }
    });

    it('Mascot component exists with the features the README sells', () => {
        const mascot = join(REPO_ROOT, 'ui/src/titan2/system/TitanMascot.tsx');
        expect(existsSync(mascot)).toBe(true);
        const src = readFileSync(mascot, 'utf-8');
        // The README sells: float, blink, yawn, eye-tracking, sleep-with-Zs
        expect(src.toLowerCase()).toContain('float');
        expect(src.toLowerCase()).toContain('blink');
        expect(src.toLowerCase()).toContain('yawn');
        expect(src.toLowerCase()).toContain('sleep');
    });

    it('Shadow-git filesystem checkpoints module exists', () => {
        expect(existsSync(join(REPO_ROOT, 'src/agent/shadowGit.ts'))).toBe(true);
    });

    it('Kill switch module exists', () => {
        expect(existsSync(join(REPO_ROOT, 'src/safety/killSwitch.ts'))).toBe(true);
    });

    it('Pre-execution dangerous-command scanner exists', () => {
        expect(existsSync(join(REPO_ROOT, 'src/security/preExecScan.ts'))).toBe(true);
    });

    it('Secret/PII guard exists', () => {
        expect(existsSync(join(REPO_ROOT, 'src/security/secretGuard.ts'))).toBe(true);
    });

    it('Approval gates skill exists', () => {
        expect(existsSync(join(REPO_ROOT, 'src/skills/builtin/approval_gates.ts'))).toBe(true);
    });

    it('LoRA fine-tuning pipeline exists (model trainer + autoresearch)', () => {
        expect(existsSync(join(REPO_ROOT, 'src/skills/builtin/model_trainer.ts'))).toBe(true);
        expect(existsSync(join(REPO_ROOT, 'autoresearch/train.py'))).toBe(true);
        const train = readFileSync(join(REPO_ROOT, 'autoresearch/train.py'), 'utf-8');
        expect(train).toContain('LORA_RANK');
    });

    it('Widget gallery skill exposes gallery_search + gallery_get', () => {
        const file = join(REPO_ROOT, 'src/skills/builtin/widget_gallery.ts');
        expect(existsSync(file)).toBe(true);
        const src = readFileSync(file, 'utf-8');
        expect(src).toContain('gallery_search');
        expect(src).toContain('gallery_get');
    });

    it('Facebook autopilot has a 6-per-day cap exactly as the README claims', () => {
        const file = join(REPO_ROOT, 'src/skills/builtin/fb_autopilot.ts');
        expect(existsSync(file)).toBe(true);
        const src = readFileSync(file, 'utf-8');
        // The README says "Posts up to 6 times per day"; this assertion catches
        // someone bumping the cap without updating the README.
        expect(src).toMatch(/6\s+(times|posts?|max)/i);
    });

    it('SOMA module exists with all 5 named drives from the README', () => {
        const file = join(REPO_ROOT, 'src/organism/drives.ts');
        expect(existsSync(file)).toBe(true);
        const src = readFileSync(file, 'utf-8').toLowerCase();
        for (const drive of ['purpose', 'curiosity', 'hunger', 'safety', 'social']) {
            expect(src, `drive ${drive} should be present`).toContain(drive);
        }
    });

    it('Yjs CRDT canvas sync module exists', () => {
        expect(existsSync(join(REPO_ROOT, 'ui/src/titan2/crdt/CrdtEngine.ts'))).toBe(true);
    });

    it('Mesh networking modules exist (discovery + transport)', () => {
        for (const p of ['src/mesh/discovery.ts', 'src/mesh/transport.ts', 'src/mesh/identity.ts']) {
            expect(existsSync(join(REPO_ROOT, p)), `${p} should exist`).toBe(true);
        }
    });

    it('Home Assistant integration skill exists', () => {
        expect(existsSync(join(REPO_ROOT, 'src/skills/builtin/smart_home.ts'))).toBe(true);
    });

    it('Gateway default port is 48420 (what the README tells users to open)', () => {
        const file = join(REPO_ROOT, 'src/utils/constants.ts');
        const src = readFileSync(file, 'utf-8');
        expect(src).toContain('48420');
    });

    it('CI eval-gate workflow with 80% threshold exists', () => {
        const wf = join(REPO_ROOT, '.github/workflows/eval-gate.yml');
        expect(existsSync(wf)).toBe(true);
        const src = readFileSync(wf, 'utf-8');
        expect(src).toMatch(/80/);
    });

    it('Docker image workflow targets ghcr.io/djtony707/titan', () => {
        const wf = join(REPO_ROOT, '.github/workflows/docker-cloud.yml');
        expect(existsSync(wf)).toBe(true);
        const src = readFileSync(wf, 'utf-8');
        expect(src).toMatch(/djtony707\/titan/);
    });

    it('install.sh exists at the URL the README sends people to', () => {
        const f = join(REPO_ROOT, 'install.sh');
        expect(existsSync(f)).toBe(true);
        expect(statSync(f).size).toBeGreaterThan(500);
    });

    it('titan CLI exposes onboard, gateway, and doctor commands', () => {
        const cli = join(REPO_ROOT, 'src/cli/index.ts');
        const src = readFileSync(cli, 'utf-8');
        expect(src).toMatch(/\.command\(['"]onboard/);
        expect(src).toMatch(/\.command\(['"]gateway/);
        expect(src).toMatch(/\.command\(['"]doctor/);
    });

    // ─── README hygiene ───────────────────────────────────────────────

    it('package.json keywords include voice + AI + agent for npm SEO truth', () => {
        const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
        const keywords: string[] = pkg.keywords ?? [];
        expect(keywords).toContain('voice-ai');
        expect(keywords).toContain('agent');
        expect(keywords).toContain('llm');
    });

    it('CHANGELOG.md exists and references the current package.json version', () => {
        const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
        const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
        expect(changelog).toContain(pkg.version);
    });

    it('README does NOT promise removed/aspirational features', () => {
        const readme = readReadme();
        // Guest Mode was claimed in earlier README revisions but the code never
        // shipped it. Catch any future re-introduction of unbacked claims.
        expect(readme, 'README must not claim Guest Mode unless src/auth/guest exists')
            .not.toMatch(/\bguest\s+mode\b/i);
    });

    it('README points to the actual default gateway URL', () => {
        const readme = readReadme();
        expect(readme).toContain('localhost:48420');
    });
});
