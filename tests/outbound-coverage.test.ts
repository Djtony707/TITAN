/**
 * TITAN — Outbound Path Coverage Tests
 *
 * Static analysis tests that verify EVERY public-facing outbound code path
 * imports and uses the outbound sanitizer. If a new public output channel
 * is added without wiring up the sanitizer, these tests will fail.
 *
 * This is the "engineering lesson" from the 2026-04-13 Facebook leak:
 * the leak happened because a new code path (fb_autopilot comment replies)
 * was added without going through the centralized safety layer. These tests
 * make that mistake catchable in CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SRC = join(process.cwd(), 'src');

/** Read a source file or return empty string if missing */
function readSource(relPath: string): string {
    const fullPath = join(SRC, relPath);
    if (!existsSync(fullPath)) return '';
    return readFileSync(fullPath, 'utf-8');
}

describe('Outbound sanitizer coverage', () => {
    describe('Public output paths must import sanitizeOutbound', () => {
        const publicOutputFiles = [
            { path: 'skills/builtin/fb_autopilot.ts', name: 'Facebook autopilot (auto comment replies)' },
            { path: 'skills/builtin/facebook.ts', name: 'Facebook tools (fb_post, fb_reply)' },
            { path: 'channels/messenger.ts', name: 'Facebook Messenger DMs' },
        ];

        for (const file of publicOutputFiles) {
            it(`${file.name} imports sanitizeOutbound`, () => {
                const src = readSource(file.path);
                expect(src.length).toBeGreaterThan(0);
                expect(src).toMatch(/sanitizeOutbound|outboundSanitizer/);
            });
        }
    });

    describe('Sanitizer module exists and is exported correctly', () => {
        it('outboundSanitizer.ts exists', () => {
            const src = readSource('utils/outboundSanitizer.ts');
            expect(src.length).toBeGreaterThan(0);
        });

        it('exports sanitizeOutbound function', () => {
            const src = readSource('utils/outboundSanitizer.ts');
            expect(src).toMatch(/export function sanitizeOutbound/);
        });

        it('exports isSafeToPost function', () => {
            const src = readSource('utils/outboundSanitizer.ts');
            expect(src).toMatch(/export function isSafeToPost/);
        });

        it('exports SanitizeResult interface', () => {
            const src = readSource('utils/outboundSanitizer.ts');
            expect(src).toMatch(/export interface SanitizeResult/);
        });
    });

    describe('FB autopilot comment reply path is sanitized', () => {
        it('monitorComments() calls sanitizeOutbound before posting', () => {
            const src = readSource('skills/builtin/fb_autopilot.ts');
            // Find the monitorComments function and verify sanitizer is called within it
            const monitorMatch = src.match(/async function monitorComments[\s\S]*?(?=\n(?:async )?function |\nexport)/);
            expect(monitorMatch).not.toBeNull();
            expect(monitorMatch?.[0]).toMatch(/sanitizeOutbound|sanitized\.text/);
        });

        it('uses safe fallback when sanitizer rejects content', () => {
            const src = readSource('skills/builtin/fb_autopilot.ts');
            // The sanitizer call should provide a fallback message
            expect(src).toMatch(/sanitizeOutbound\([^)]+,\s*['"]fb_autopilot/);
        });
    });

    describe('Facebook tool path is sanitized', () => {
        it('postToPage() calls sanitizeOutbound before posting', () => {
            const src = readSource('skills/builtin/facebook.ts');
            const postMatch = src.match(/postToPage[\s\S]*?(?=\nexport function|\n}\n\nexport)/);
            expect(postMatch).not.toBeNull();
            expect(postMatch?.[0]).toMatch(/sanitizeOutbound/);
        });

        it('fb_reply tool calls sanitizeOutbound', () => {
            const src = readSource('skills/builtin/facebook.ts');
            // Look for fb_reply registration and sanitizer call nearby
            const replyIdx = src.indexOf("name: 'fb_reply'");
            expect(replyIdx).toBeGreaterThan(-1);
            // Sanitizer should be called within ~3000 chars of the fb_reply definition
            const replySection = src.slice(replyIdx, replyIdx + 3000);
            expect(replySection).toMatch(/sanitizeOutbound/);
        });
    });

    describe('Messenger channel is sanitized', () => {
        it('cleanReply() calls sanitizeOutbound', () => {
            const src = readSource('channels/messenger.ts');
            // Find the cleanReply method definition and check the next ~500 chars for sanitizer call
            const cleanIdx = src.indexOf('cleanReply(content: string)');
            expect(cleanIdx).toBeGreaterThan(-1);
            const cleanBody = src.slice(cleanIdx, cleanIdx + 800);
            expect(cleanBody).toMatch(/sanitizeOutbound|outboundSanitizer/);
        });

        it('messenger.ts imports outboundSanitizer module', () => {
            const src = readSource('channels/messenger.ts');
            expect(src).toMatch(/['"][^'"]*outboundSanitizer/);
        });
    });

    describe('Sanitizer pattern coverage (regression)', () => {
        it('sanitizer source contains the patterns that block the 2026-04-13 leak', () => {
            const src = readSource('utils/outboundSanitizer.ts');
            // These patterns must exist or the leak could happen again
            expect(src).toMatch(/no hashtags/i);
            expect(src).toMatch(/no internal thoughts/i);
            expect(src).toMatch(/respond directly/i);
            expect(src).toMatch(/INSTRUCTION_LEAK_PATTERNS/);
        });

        it('sanitizer source contains PII patterns', () => {
            const src = readSource('utils/outboundSanitizer.ts');
            expect(src).toMatch(/PII_PATTERNS/);
        });
    });
});
