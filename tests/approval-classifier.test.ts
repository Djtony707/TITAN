/**
 * Gap 4 (plan-this-logical-ocean) — Approval Classifier unit tests.
 *
 * The classifier is pure: given an intent and a rule list, return
 * auto/require/unknown. No commandPost, no filesystem, no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import {
    classifyApprovalIntent,
    shouldAutoApprove,
    type ApprovalRule,
} from '../src/agent/approvalClassifier.js';

describe('approvalClassifier — built-in defaults', () => {
    it('auto-approves read_file under /opt/TITAN', () => {
        const action = classifyApprovalIntent({
            type: 'custom',
            payload: { kind: 'read_file', path: '/opt/TITAN/docs/README.md' },
        });
        expect(action).toBe('auto');
    });

    it('auto-approves list_files under /tmp', () => {
        const action = classifyApprovalIntent({
            type: 'custom',
            payload: { kind: 'list_files', path: '/tmp/scratch' },
        });
        expect(action).toBe('auto');
    });

    it('auto-approves read_file under ~/Desktop/TitanBot', () => {
        const home = process.env.HOME || '/Users/unknown';
        const action = classifyApprovalIntent({
            type: 'custom',
            payload: { kind: 'read_file', path: `${home}/Desktop/TitanBot/notes.md` },
        });
        expect(action).toBe('auto');
    });

    it('returns unknown for writes under /opt/TITAN (writes are not readonly)', () => {
        const action = classifyApprovalIntent({
            type: 'custom',
            payload: { kind: 'write_file', path: '/opt/TITAN/docs/README.md' },
        });
        expect(action).toBe('unknown');
    });

    it('returns unknown for reads outside allowlisted paths', () => {
        const action = classifyApprovalIntent({
            type: 'custom',
            payload: { kind: 'read_file', path: '/etc/passwd' },
        });
        expect(action).toBe('unknown');
    });

    it('returns unknown when payload has no path', () => {
        const action = classifyApprovalIntent({
            type: 'custom',
            payload: { kind: 'read_file' },
        });
        expect(action).toBe('unknown');
    });

    it('returns unknown for hire_agent type (not a readonly kind)', () => {
        const action = classifyApprovalIntent({
            type: 'hire_agent',
            payload: { name: 'scout-2', role: 'scout' },
        });
        expect(action).toBe('unknown');
    });
});

describe('approvalClassifier — user rules override defaults', () => {
    it('user require rule beats default auto', () => {
        const rules: ApprovalRule[] = [
            { type: 'custom', kind: 'read_file', pathPrefix: '/opt/TITAN/secrets', action: 'require' },
        ];
        const action = classifyApprovalIntent(
            {
                type: 'custom',
                payload: { kind: 'read_file', path: '/opt/TITAN/secrets/key.pem' },
            },
            rules,
        );
        expect(action).toBe('require');
    });

    it('user auto rule can whitelist a new path', () => {
        const rules: ApprovalRule[] = [
            { type: 'custom', kind: 'read_file', pathPrefix: '/var/log', action: 'auto' },
        ];
        const action = classifyApprovalIntent(
            { type: 'custom', payload: { kind: 'read_file', path: '/var/log/titan.log' } },
            rules,
        );
        expect(action).toBe('auto');
    });

    it('first matching rule wins', () => {
        const rules: ApprovalRule[] = [
            { type: '*', kind: 'read_file', action: 'require' },
            // Never reached
            { type: 'custom', kind: 'read_file', pathPrefix: '/opt/TITAN', action: 'auto' },
        ];
        const action = classifyApprovalIntent(
            { type: 'custom', payload: { kind: 'read_file', path: '/opt/TITAN/a.md' } },
            rules,
        );
        expect(action).toBe('require');
    });

    it('wildcard type matches any type', () => {
        const rules: ApprovalRule[] = [
            { type: '*', kind: 'shell', action: 'require' },
        ];
        const action = classifyApprovalIntent(
            { type: 'hire_agent', payload: { kind: 'shell', command: 'ls' } },
            rules,
        );
        expect(action).toBe('require');
    });
});

describe('shouldAutoApprove — config gate', () => {
    it('returns false when autoApprove.enabled is false', () => {
        const result = shouldAutoApprove(
            { type: 'custom', payload: { kind: 'read_file', path: '/opt/TITAN/a.md' } },
            { enabled: false, rules: [] },
        );
        expect(result).toBe(false);
    });

    it('returns false when config is undefined', () => {
        const result = shouldAutoApprove(
            { type: 'custom', payload: { kind: 'read_file', path: '/opt/TITAN/a.md' } },
            undefined,
        );
        expect(result).toBe(false);
    });

    it('returns true when enabled and intent matches default', () => {
        const result = shouldAutoApprove(
            { type: 'custom', payload: { kind: 'read_file', path: '/opt/TITAN/a.md' } },
            { enabled: true, rules: [] },
        );
        expect(result).toBe(true);
    });

    it('returns false when enabled but intent does not match', () => {
        const result = shouldAutoApprove(
            { type: 'custom', payload: { kind: 'write_file', path: '/opt/TITAN/a.md' } },
            { enabled: true, rules: [] },
        );
        expect(result).toBe(false);
    });
});
