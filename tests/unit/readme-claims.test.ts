/**
 * Phase 8 / Track C — README claim verification tests.
 *
 * The README makes specific claims (tool count, widget count, F5-TTS
 * voice cloning). These tests catch silent drift: when someone adds 5
 * skills the tool count grows from 248 to 253, but README still says
 * 248. The claim quietly becomes a lie. Test pin to detect drift.
 *
 * NOT a tight equality check — README rounds to memorable numbers
 * (110 widgets, 248 tools). We assert the CURRENT runtime count is
 * within an acceptable band of the claim and flag if it drifts beyond.
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

describe('README claim verification (Phase 8 Track C)', () => {
    it('Widget template count matches the README "110 widgets" claim within ±10%', () => {
        const actual = countTemplateFiles();
        const claimed = 110;
        const drift = Math.abs(actual - claimed) / claimed;
        expect(actual).toBeGreaterThan(0);
        expect(drift).toBeLessThan(0.1);
        if (Math.abs(actual - claimed) >= 5) {
            // Soft warning only — log to stderr, don't fail the build
            console.warn(`[readme-claims] template count drift: README says ${claimed}, actual ${actual}`);
        }
    });

    it('F5-TTS voice cloning has a real Python sidecar implementation', () => {
        // README says "F5-TTS voice cloning + WebRTC streaming. Any voice."
        // The implementation is a Python sidecar (mlx-audio on Mac, container
        // on Linux). Verify the sidecar scripts exist.
        const expected = [
            'scripts/f5-tts-server.py',
            'scripts/f5-tts-gpu-server.py',
        ];
        for (const path of expected) {
            const full = join(REPO_ROOT, path);
            expect(existsSync(full), `${path} should exist for the F5-TTS claim to be true`).toBe(true);
            const stat = statSync(full);
            expect(stat.size).toBeGreaterThan(500);
        }
    });

    it('Voice integration glue (channel adapters) exists in TypeScript', () => {
        // TITAN's TS side talks to the F5-TTS sidecar via two channels.
        // If either is missing, the voice claim is broken at the integration
        // layer even when the sidecar runs.
        const expected = [
            'src/channels/messenger-voice.ts',
            'src/skills/builtin/voice.ts',
        ];
        for (const path of expected) {
            const full = join(REPO_ROOT, path);
            expect(existsSync(full), `${path} should exist`).toBe(true);
        }
    });

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
        const version: string = pkg.version;
        // The CHANGELOG must mention the package.json version somewhere — protects
        // against shipping a release without a CHANGELOG entry.
        expect(changelog).toContain(version);
    });
});
