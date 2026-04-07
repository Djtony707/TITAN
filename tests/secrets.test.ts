/**
 * TITAN — Encrypted Secrets Vault Tests
 * Tests src/security/secrets.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// We use real crypto but mock fs operations
const mockFs = {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
};

vi.mock('fs', () => ({
    readFileSync: (...args: any[]) => mockFs.readFileSync(...args),
    writeFileSync: (...args: any[]) => mockFs.writeFileSync(...args),
    existsSync: (...args: any[]) => mockFs.existsSync(...args),
    mkdirSync: (...args: any[]) => mockFs.mkdirSync(...args),
    appendFileSync: (...args: any[]) => mockFs.appendFileSync(...args),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/mock/.titan',
}));

import {
    initVault,
    unlockVault,
    lockVault,
    setSecret,
    getSecret,
    deleteSecret,
    listSecretNames,
    isVaultUnlocked,
    setVaultPath,
    getVaultPath,
} from '../src/security/secrets.js';

// Helpers to capture what was written to the vault file
function getLastWrittenVault(): any {
    const calls = mockFs.writeFileSync.mock.calls;
    if (calls.length === 0) return null;
    const lastCall = calls[calls.length - 1];
    return JSON.parse(lastCall[1] as string);
}

describe('Encrypted Secrets Vault', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        lockVault(); // ensure clean state
        mockFs.existsSync.mockReturnValue(false);
        mockFs.mkdirSync.mockReturnValue(undefined);
        mockFs.writeFileSync.mockReturnValue(undefined);
        setVaultPath('/mock/.titan/vault.enc');
    });

    afterEach(() => {
        lockVault();
    });

    // ─── setVaultPath / getVaultPath ─────────────────────────────

    describe('setVaultPath / getVaultPath', () => {
        it('should set and get the vault path', () => {
            setVaultPath('/custom/path/vault.enc');
            expect(getVaultPath()).toBe('/custom/path/vault.enc');
        });

        it('should default to ~/.titan/vault.enc', () => {
            setVaultPath('/mock/.titan/vault.enc');
            expect(getVaultPath()).toBe('/mock/.titan/vault.enc');
        });
    });

    // ─── initVault ───────────────────────────────────────────────

    describe('initVault', () => {
        it('should create a vault file with valid structure', () => {
            initVault('my-secret-passphrase');
            const vault = getLastWrittenVault();
            expect(vault).toBeTruthy();
            expect(vault).toHaveProperty('salt');
            expect(vault).toHaveProperty('iv');
            expect(vault).toHaveProperty('authTag');
            expect(vault).toHaveProperty('data');
        });

        it('should produce hex-encoded salt of 64 chars (32 bytes)', () => {
            initVault('passphrase');
            const vault = getLastWrittenVault();
            expect(vault.salt).toMatch(/^[0-9a-f]{64}$/);
        });

        it('should produce hex-encoded IV of 32 chars (16 bytes)', () => {
            initVault('passphrase');
            const vault = getLastWrittenVault();
            expect(vault.iv).toMatch(/^[0-9a-f]{32}$/);
        });

        it('should produce a non-empty authTag', () => {
            initVault('passphrase');
            const vault = getLastWrittenVault();
            expect(vault.authTag.length).toBeGreaterThan(0);
        });

        it('should mark vault as unlocked after init', () => {
            initVault('passphrase');
            expect(isVaultUnlocked()).toBe(true);
        });

        it('should write to the configured vault path', () => {
            setVaultPath('/custom/vault.enc');
            initVault('passphrase');
            expect(mockFs.writeFileSync).toHaveBeenCalledWith(
                '/custom/vault.enc',
                expect.any(String),
                'utf-8',
            );
        });

        it('should create parent directory if it does not exist', () => {
            mockFs.existsSync.mockReturnValue(false);
            initVault('passphrase');
            expect(mockFs.mkdirSync).toHaveBeenCalled();
        });

        it('should throw for empty passphrase', () => {
            expect(() => initVault('')).toThrow('Passphrase must not be empty');
        });

        it('should produce different salts each time', () => {
            initVault('same-pass');
            const vault1 = getLastWrittenVault();
            lockVault();
            initVault('same-pass');
            const vault2 = getLastWrittenVault();
            expect(vault1.salt).not.toBe(vault2.salt);
        });

        it('should produce different IVs each time', () => {
            initVault('same-pass');
            const vault1 = getLastWrittenVault();
            lockVault();
            initVault('same-pass');
            const vault2 = getLastWrittenVault();
            expect(vault1.iv).not.toBe(vault2.iv);
        });
    });

    // ─── unlockVault ─────────────────────────────────────────────

    describe('unlockVault', () => {
        it('should unlock a previously initialized vault', () => {
            // Init vault
            initVault('mypass');
            const vaultData = getLastWrittenVault();

            // Lock it
            lockVault();
            expect(isVaultUnlocked()).toBe(false);

            // Setup mock to return the saved vault data
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            // Unlock it
            unlockVault('mypass');
            expect(isVaultUnlocked()).toBe(true);
        });

        it('should throw for empty passphrase', () => {
            expect(() => unlockVault('')).toThrow('Passphrase must not be empty');
        });

        it('should throw if vault file does not exist', () => {
            mockFs.existsSync.mockReturnValue(false);
            expect(() => unlockVault('pass')).toThrow('Vault file not found');
        });

        it('should throw for corrupted vault file (invalid JSON)', () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue('not-valid-json');
            expect(() => unlockVault('pass')).toThrow('corrupted');
        });

        it('should throw for vault file missing required fields', () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify({ salt: 'abc' }));
            expect(() => unlockVault('pass')).toThrow('missing required fields');
        });

        it('should throw for wrong passphrase', () => {
            initVault('correct-pass');
            const vaultData = getLastWrittenVault();
            lockVault();

            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            expect(() => unlockVault('wrong-pass')).toThrow('Failed to decrypt');
        });

        it('should restore secrets after unlock', () => {
            initVault('pass');
            setSecret('API_KEY', 'sk-12345');
            const vaultData = getLastWrittenVault();
            lockVault();

            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            unlockVault('pass');
            expect(getSecret('API_KEY')).toBe('sk-12345');
        });

        it('should restore multiple secrets after unlock', () => {
            initVault('pass');
            setSecret('KEY_1', 'value1');
            setSecret('KEY_2', 'value2');
            setSecret('KEY_3', 'value3');
            const vaultData = getLastWrittenVault();
            lockVault();

            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            unlockVault('pass');
            expect(getSecret('KEY_1')).toBe('value1');
            expect(getSecret('KEY_2')).toBe('value2');
            expect(getSecret('KEY_3')).toBe('value3');
        });
    });

    // ─── setSecret ───────────────────────────────────────────────

    describe('setSecret', () => {
        beforeEach(() => {
            mockFs.existsSync.mockReturnValue(true);
            initVault('pass');
        });

        it('should store a secret', () => {
            setSecret('my_key', 'my_value');
            expect(getSecret('my_key')).toBe('my_value');
        });

        it('should persist vault to disk after setting', () => {
            const callsBefore = mockFs.writeFileSync.mock.calls.length;
            setSecret('key', 'val');
            expect(mockFs.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore);
        });

        it('should overwrite existing secret', () => {
            setSecret('key', 'old');
            setSecret('key', 'new');
            expect(getSecret('key')).toBe('new');
        });

        it('should throw when vault is locked', () => {
            lockVault();
            expect(() => setSecret('key', 'val')).toThrow('Vault is locked');
        });

        it('should throw for empty secret name', () => {
            expect(() => setSecret('', 'val')).toThrow('Secret name must not be empty');
        });

        it('should handle special characters in values', () => {
            setSecret('special', '!@#$%^&*()_+{}|:<>?');
            expect(getSecret('special')).toBe('!@#$%^&*()_+{}|:<>?');
        });

        it('should handle unicode values', () => {
            setSecret('unicode', '\u00e9\u00e8\u00ea \u2603 \ud83d\ude80');
            expect(getSecret('unicode')).toBe('\u00e9\u00e8\u00ea \u2603 \ud83d\ude80');
        });

        it('should handle empty string values', () => {
            setSecret('empty', '');
            expect(getSecret('empty')).toBe('');
        });

        it('should handle very long values', () => {
            const longValue = 'x'.repeat(10000);
            setSecret('long', longValue);
            expect(getSecret('long')).toBe(longValue);
        });

        it('should handle names with dots and slashes', () => {
            setSecret('provider.api-key/v2', 'value123');
            expect(getSecret('provider.api-key/v2')).toBe('value123');
        });
    });

    // ─── getSecret ───────────────────────────────────────────────

    describe('getSecret', () => {
        it('should return undefined when vault is locked', () => {
            expect(getSecret('anything')).toBeUndefined();
        });

        it('should return undefined for non-existent secret', () => {
            initVault('pass');
            expect(getSecret('nonexistent')).toBeUndefined();
        });

        it('should return the correct value for an existing secret', () => {
            initVault('pass');
            setSecret('key', 'value');
            expect(getSecret('key')).toBe('value');
        });

        it('should return the updated value after overwrite', () => {
            initVault('pass');
            setSecret('key', 'v1');
            setSecret('key', 'v2');
            expect(getSecret('key')).toBe('v2');
        });
    });

    // ─── deleteSecret ────────────────────────────────────────────

    describe('deleteSecret', () => {
        beforeEach(() => {
            mockFs.existsSync.mockReturnValue(true);
            initVault('pass');
        });

        it('should return true when deleting an existing secret', () => {
            setSecret('key', 'val');
            expect(deleteSecret('key')).toBe(true);
        });

        it('should remove the secret so getSecret returns undefined', () => {
            setSecret('key', 'val');
            deleteSecret('key');
            expect(getSecret('key')).toBeUndefined();
        });

        it('should return false when deleting a non-existent secret', () => {
            expect(deleteSecret('nonexistent')).toBe(false);
        });

        it('should persist vault after deletion', () => {
            setSecret('key', 'val');
            const callsBefore = mockFs.writeFileSync.mock.calls.length;
            deleteSecret('key');
            expect(mockFs.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore);
        });

        it('should not persist vault when deleting non-existent secret', () => {
            const callsBefore = mockFs.writeFileSync.mock.calls.length;
            deleteSecret('nonexistent');
            expect(mockFs.writeFileSync.mock.calls.length).toBe(callsBefore);
        });

        it('should throw when vault is locked', () => {
            lockVault();
            expect(() => deleteSecret('key')).toThrow('Vault is locked');
        });

        it('should not affect other secrets when deleting one', () => {
            setSecret('a', '1');
            setSecret('b', '2');
            setSecret('c', '3');
            deleteSecret('b');
            expect(getSecret('a')).toBe('1');
            expect(getSecret('b')).toBeUndefined();
            expect(getSecret('c')).toBe('3');
        });
    });

    // ─── listSecretNames ─────────────────────────────────────────

    describe('listSecretNames', () => {
        it('should return empty array when vault is locked', () => {
            expect(listSecretNames()).toEqual([]);
        });

        it('should return empty array for empty vault', () => {
            initVault('pass');
            expect(listSecretNames()).toEqual([]);
        });

        it('should list all secret names', () => {
            initVault('pass');
            setSecret('alpha', 'a');
            setSecret('beta', 'b');
            setSecret('gamma', 'c');
            const names = listSecretNames();
            expect(names).toContain('alpha');
            expect(names).toContain('beta');
            expect(names).toContain('gamma');
            expect(names.length).toBe(3);
        });

        it('should not include deleted secrets', () => {
            initVault('pass');
            setSecret('keep', '1');
            setSecret('remove', '2');
            deleteSecret('remove');
            const names = listSecretNames();
            expect(names).toContain('keep');
            expect(names).not.toContain('remove');
        });

        it('should return updated list after adding', () => {
            initVault('pass');
            expect(listSecretNames().length).toBe(0);
            setSecret('new', 'val');
            expect(listSecretNames().length).toBe(1);
        });
    });

    // ─── lockVault ───────────────────────────────────────────────

    describe('lockVault', () => {
        it('should mark vault as locked', () => {
            initVault('pass');
            expect(isVaultUnlocked()).toBe(true);
            lockVault();
            expect(isVaultUnlocked()).toBe(false);
        });

        it('should clear all secrets from memory', () => {
            initVault('pass');
            setSecret('key', 'val');
            lockVault();
            expect(getSecret('key')).toBeUndefined();
            expect(listSecretNames()).toEqual([]);
        });

        it('should be safe to call multiple times', () => {
            lockVault();
            lockVault();
            lockVault();
            expect(isVaultUnlocked()).toBe(false);
        });

        it('should be safe to call when already locked', () => {
            expect(() => lockVault()).not.toThrow();
        });
    });

    // ─── isVaultUnlocked ─────────────────────────────────────────

    describe('isVaultUnlocked', () => {
        it('should return false initially', () => {
            expect(isVaultUnlocked()).toBe(false);
        });

        it('should return true after initVault', () => {
            initVault('pass');
            expect(isVaultUnlocked()).toBe(true);
        });

        it('should return true after unlockVault', () => {
            initVault('pass');
            const vaultData = getLastWrittenVault();
            lockVault();

            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            unlockVault('pass');
            expect(isVaultUnlocked()).toBe(true);
        });

        it('should return false after lockVault', () => {
            initVault('pass');
            lockVault();
            expect(isVaultUnlocked()).toBe(false);
        });
    });

    // ─── Full CRUD lifecycle ─────────────────────────────────────

    describe('Full CRUD lifecycle', () => {
        it('should support create, read, update, delete cycle', () => {
            initVault('lifecycle-pass');

            // Create
            setSecret('db_password', 'initial');
            expect(getSecret('db_password')).toBe('initial');

            // Update
            setSecret('db_password', 'updated');
            expect(getSecret('db_password')).toBe('updated');

            // List
            expect(listSecretNames()).toContain('db_password');

            // Delete
            expect(deleteSecret('db_password')).toBe(true);
            expect(getSecret('db_password')).toBeUndefined();
            expect(listSecretNames()).not.toContain('db_password');
        });

        it('should handle many secrets', () => {
            initVault('pass');
            for (let i = 0; i < 50; i++) {
                setSecret(`key_${i}`, `value_${i}`);
            }
            expect(listSecretNames().length).toBe(50);
            for (let i = 0; i < 50; i++) {
                expect(getSecret(`key_${i}`)).toBe(`value_${i}`);
            }
        });

        it('should survive lock/unlock cycle with secrets intact', () => {
            initVault('pass');
            setSecret('survive', 'this');
            setSecret('also', 'that');
            const vaultData = getLastWrittenVault();

            lockVault();
            expect(getSecret('survive')).toBeUndefined();

            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            unlockVault('pass');
            expect(getSecret('survive')).toBe('this');
            expect(getSecret('also')).toBe('that');
        });

        it('should persist deletes across lock/unlock cycles', () => {
            initVault('pass');
            setSecret('keep', 'yes');
            setSecret('remove', 'no');
            deleteSecret('remove');
            const vaultData = getLastWrittenVault();

            lockVault();

            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify(vaultData));

            unlockVault('pass');
            expect(getSecret('keep')).toBe('yes');
            expect(getSecret('remove')).toBeUndefined();
        });
    });

    // ─── Edge cases ──────────────────────────────────────────────

    describe('Edge cases', () => {
        it('should handle newlines in secret values', () => {
            initVault('pass');
            setSecret('multiline', 'line1\nline2\nline3');
            expect(getSecret('multiline')).toBe('line1\nline2\nline3');
        });

        it('should handle JSON strings as values', () => {
            initVault('pass');
            const jsonVal = JSON.stringify({ nested: true, count: 42 });
            setSecret('json', jsonVal);
            expect(getSecret('json')).toBe(jsonVal);
        });

        it('should handle secret names with special characters', () => {
            initVault('pass');
            setSecret('my/nested.key-name_v2', 'value');
            expect(getSecret('my/nested.key-name_v2')).toBe('value');
        });

        it('should throw when vault file has empty salt', () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.readFileSync.mockReturnValue(JSON.stringify({
                salt: '', iv: 'aa', authTag: 'bb', data: 'cc',
            }));
            expect(() => unlockVault('pass')).toThrow('missing required fields');
        });
    });
});
