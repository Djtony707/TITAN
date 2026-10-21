import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt, generateKey, type EncryptedPayload } from '../src/security/encryption.js';
import {
    getSecret, getVaultPath, initVault, isVaultUnlocked, lockVault,
    setSecret, setVaultPath, unlockVault, type VaultFile,
} from '../src/security/secrets.js';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Generate the existing format independently. No owner key, vault or plaintext is read.
function legacyPayload(text: string, key: Buffer, ivBytes = 16): EncryptedPayload {
    const iv = randomBytes(ivBytes);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
}

const shorterTags = [4, 8, 12, 13, 14, 15];

describe('session GCM authenticated format', () => {
    it.each(shorterTags)('rejects a valid tag truncated to %i bytes', (bytes) => {
        const key = generateKey();
        const payload = legacyPayload('synthetic session', key);
        expect(() => decrypt({ ...payload, authTag: payload.authTag.slice(0, bytes * 2) }, key)).toThrow();
    });

    it.each(['iv', 'authTag', 'data'] as const)('rejects non-hex and odd-length %s encodings', (field) => {
        const key = generateKey();
        const payload = legacyPayload('synthetic session', key);
        for (const suffix of ['gg', '0']) {
            expect(() => decrypt({ ...payload, [field]: payload[field] + suffix }, key)).toThrow();
        }
        expect(() => decrypt({ ...payload, [field]: 42 } as unknown as EncryptedPayload, key)).toThrow();
    });

    it('rejects a cryptographically valid IV outside the existing 16-byte format', () => {
        const key = generateKey();
        expect(() => decrypt(legacyPayload('synthetic session', key, 12), key)).toThrow();
    });

    it('rejects malformed hex keys rather than silently truncating their encoding', () => {
        const key = generateKey();
        const payload = legacyPayload('synthetic session', key);
        for (const suffix of ['gg', '0']) {
            expect(() => encrypt('synthetic session', key.toString('hex') + suffix)).toThrow();
            expect(() => decrypt(payload, key.toString('hex') + suffix)).toThrow();
        }
    });

    it.each(['', 'Existing session', 'Unicode: hello 🌻\n\u0000'])('retains existing 16-byte-tag payloads: %j', (text) => {
        const key = generateKey();
        const payload = legacyPayload(text, key);
        expect(decrypt(payload, key)).toBe(text);
        expect(decrypt({ iv: payload.iv.toUpperCase(), authTag: payload.authTag.toUpperCase(), data: payload.data.toUpperCase() }, key.toString('hex').toUpperCase())).toBe(text);
        const current = encrypt(text, key);
        expect(current.iv).toMatch(/^[0-9a-f]{32}$/);
        expect(current.authTag).toMatch(/^[0-9a-f]{32}$/);
        expect(decrypt(current, key)).toBe(text);
    });

    it('rejects ciphertext tampering, tag tampering and the wrong key', () => {
        const key = generateKey();
        const payload = legacyPayload('synthetic session', key);
        const change = (hex: string) => (hex.startsWith('00') ? '01' : '00') + hex.slice(2);
        expect(() => decrypt({ ...payload, data: change(payload.data) }, key)).toThrow();
        expect(() => decrypt({ ...payload, authTag: change(payload.authTag) }, key)).toThrow();
        expect(() => decrypt(payload, generateKey())).toThrow();
    });
});

describe('vault GCM authenticated format', () => {
    const passphrase = 'synthetic-vault-format-passphrase';
    const previousPath = getVaultPath();
    let root: string;
    let path: string;
    let fixture: VaultFile;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'titan-gcm-format-'));
        const salt = randomBytes(32);
        const key = pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha512');
        fixture = { salt: salt.toString('hex'), ...legacyPayload(JSON.stringify({ fixture: 'synthetic value' }), key) };
    });
    beforeEach(() => {
        lockVault();
        path = join(root, 'synthetic-vault.enc');
        setVaultPath(path);
        writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 });
    });
    afterEach(() => lockVault());
    afterAll(() => {
        setVaultPath(previousPath);
        rmSync(root, { recursive: true, force: true });
    });

    const replace = (change: Partial<VaultFile>) => writeFileSync(path, JSON.stringify({ ...fixture, ...change }));

    it.each(shorterTags)('rejects a valid vault tag truncated to %i bytes', (bytes) => {
        replace({ authTag: fixture.authTag.slice(0, bytes * 2) });
        expect(() => unlockVault(passphrase)).toThrow('Failed to decrypt');
        expect(isVaultUnlocked()).toBe(false);
    });

    it.each(['salt', 'iv', 'authTag', 'data'] as const)('rejects malformed vault %s encoding', (field) => {
        for (const value of [fixture[field] + 'gg', fixture[field] + '0', 42]) {
            replace({ [field]: value } as Partial<VaultFile>);
            expect(() => unlockVault(passphrase)).toThrow();
            expect(isVaultUnlocked()).toBe(false);
        }
    });

    it('rejects a cryptographically valid non-format IV or salt length', () => {
        const salt = randomBytes(32);
        const key = pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha512');
        replace({ salt: salt.toString('hex'), ...legacyPayload('{}', key, 12) });
        expect(() => unlockVault(passphrase)).toThrow('Failed to decrypt');
        const shortSalt = randomBytes(16);
        const shortSaltKey = pbkdf2Sync(passphrase, shortSalt, 100_000, 32, 'sha512');
        replace({ salt: shortSalt.toString('hex'), ...legacyPayload('{}', shortSaltKey) });
        expect(() => unlockVault(passphrase)).toThrow('Failed to decrypt');
    });

    it('unlocks a legitimate existing vault without rewriting its contents', () => {
        const before = readFileSync(path);
        unlockVault(passphrase);
        expect(getSecret('fixture')).toBe('synthetic value');
        expect(readFileSync(path)).toEqual(before);
        lockVault();
        replace(Object.fromEntries(Object.entries(fixture).map(([key, value]) => [key, value.toUpperCase()])));
        unlockVault(passphrase);
        expect(getSecret('fixture')).toBe('synthetic value');
    });

    it('preserves initialization, persistence and reopening with full tags', () => {
        initVault(passphrase);
        setSecret('fixture', 'new synthetic value');
        const written = JSON.parse(readFileSync(path, 'utf8')) as VaultFile;
        expect(written.salt).toMatch(/^[0-9a-f]{64}$/);
        expect(written.iv).toMatch(/^[0-9a-f]{32}$/);
        expect(written.authTag).toMatch(/^[0-9a-f]{32}$/);
        lockVault();
        unlockVault(passphrase);
        expect(getSecret('fixture')).toBe('new synthetic value');
    });

    it('rejects wrong passphrases and tampered data or full authentication tags', () => {
        expect(() => unlockVault('wrong synthetic passphrase')).toThrow('Failed to decrypt');
        const change = (hex: string) => (hex.startsWith('00') ? '01' : '00') + hex.slice(2);
        replace({ data: change(fixture.data) });
        expect(() => unlockVault(passphrase)).toThrow('Failed to decrypt');
        replace({ authTag: change(fixture.authTag) });
        expect(() => unlockVault(passphrase)).toThrow('Failed to decrypt');
        expect(isVaultUnlocked()).toBe(false);
    });
});
