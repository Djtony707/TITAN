/**
 * TITAN — Unit Tests: secretGuard
 *
 * Secret detection, redaction, and blocking.
 */
import { describe, it, expect } from 'vitest';
import { scanForSecrets, redactSecrets, containsSecrets } from '../../src/security/secretGuard.js';

describe('scanForSecrets', () => {
    it('returns clean for harmless text', () => {
        const result = scanForSecrets('hello world, this is a normal message');
        expect(result.clean).toBe(true);
        expect(result.matches).toEqual([]);
        expect(result.redacted).toBe('hello world, this is a normal message');
    });

    it('detects OpenAI API key', () => {
        const key = 'sk-' + 'a'.repeat(48);
        const result = scanForSecrets(`My key is ${key}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('openai_api_key');
        expect(result.redacted).toContain('[REDACTED:openai_api_key]');
        expect(result.redacted).not.toContain(key);
    });

    it('detects Google API key', () => {
        const key = 'AIza' + 'x'.repeat(35);
        const result = scanForSecrets(`Google key: ${key}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('google_api_key');
    });

    it('detects AWS access key', () => {
        const key = 'AKIA' + 'B'.repeat(16);
        const result = scanForSecrets(`AWS: ${key}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('aws_access_key');
    });

    it('detects GitHub token', () => {
        const token = 'ghp_' + 'a'.repeat(36);
        const result = scanForSecrets(`Token: ${token}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('github_token');
    });

    it('detects GitLab token', () => {
        const token = 'glpat-' + 'a'.repeat(20);
        const result = scanForSecrets(`GitLab: ${token}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('gitlab_token');
    });

    it('detects Bearer token', () => {
        const token = 'Bearer ' + 'x'.repeat(30);
        const result = scanForSecrets(`Authorization: ${token}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('bearer_token');
    });

    it('detects generic API key', () => {
        const result = scanForSecrets('api_key=abc123def456ghi789');
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('generic_api_key');
    });

    it('detects JWT', () => {
        // Build the JWT via concatenation so GitHub secret scanning doesn't
        // flag this fixture as a real leaked credential.
        const header = 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
        const payload = 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';
        const sig = 'SflKxwRJSMeKKF2QT4fwpMeJ' + 'f36POk6yJV_adQssw5c';
        const jwt = `${header}.${payload}.${sig}`;
        const result = scanForSecrets(`Token: ${jwt}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('jwt');
    });

    it('detects Slack token', () => {
        // Build the token via concatenation so GitHub secret scanning doesn't
        // flag this fixture as a real leaked credential.
        const token = 'xoxb' + '-1234567890123-1234567890123-' + 'a'.repeat(24);
        const result = scanForSecrets(`Slack: ${token}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('slack_token');
    });

    it('detects Stripe key', () => {
        const key = 'sk_live_' + 'a'.repeat(24);
        const result = scanForSecrets(`Stripe: ${key}`);
        expect(result.clean).toBe(false);
        expect(result.matches[0].type).toBe('stripe_key');
    });

    it('detects password in connection string', () => {
        const result = scanForSecrets('host=localhost;password=secret123;user=admin');
        expect(result.clean).toBe(false);
        expect(result.matches.some(m => m.type === 'db_password')).toBe(true);
    });

    it('detects env var secret', () => {
        const result = scanForSecrets('API_SECRET=supersecrettoken123');
        expect(result.clean).toBe(false);
        expect(result.matches.some(m => m.type === 'env_secret')).toBe(true);
    });

    it('detects multiple secrets in one text', () => {
        const openai = 'sk-' + 'a'.repeat(48);
        const github = 'ghp_' + 'b'.repeat(36);
        const result = scanForSecrets(`OpenAI: ${openai} and GitHub: ${github}`);
        expect(result.clean).toBe(false);
        expect(result.matches.length).toBeGreaterThanOrEqual(2);
    });

    it('redacts without mutating original', () => {
        const original = 'key=sk-' + 'a'.repeat(48);
        const result = scanForSecrets(original);
        expect(original).toContain('sk-');
        expect(result.redacted).toContain('[REDACTED:');
    });

    it('handles empty string', () => {
        const result = scanForSecrets('');
        expect(result.clean).toBe(true);
        expect(result.redacted).toBe('');
    });
});

describe('redactSecrets', () => {
    it('returns redacted text', () => {
        const openai = 'sk-' + 'a'.repeat(48);
        const result = redactSecrets(`Key: ${openai}`);
        expect(result).toContain('[REDACTED:openai_api_key]');
    });

    it('returns original when no secrets', () => {
        const text = 'just a normal message';
        expect(redactSecrets(text)).toBe(text);
    });
});

describe('containsSecrets', () => {
    it('returns true when secrets found', () => {
        expect(containsSecrets('sk-' + 'a'.repeat(48))).toBe(true);
    });

    it('returns false when no secrets', () => {
        expect(containsSecrets('hello world')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(containsSecrets('')).toBe(false);
    });
});
