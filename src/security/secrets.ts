/**
 * TITAN — Encrypted Secrets Vault
 * AES-256-GCM encryption with PBKDF2 key derivation.
 * Stores secrets at ~/.titan/vault.enc
 */
import {
    randomBytes,
    pbkdf2Sync,
    createCipheriv,
    createDecipheriv,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { atomicWriteJsonFile } from '../utils/helpers.js';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Vault';
const ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = 'sha512';
const SALT_LEN = 32;
const IV_LEN = 16;

/** On-disk vault format */
export interface VaultFile {
    salt: string;   // hex
    iv: string;     // hex
    authTag: string; // hex
    data: string;   // hex — encrypted JSON of Record<string, string>
}

/** In-memory vault state */
let secrets: Map<string, string> | null = null;
let masterKey: Buffer | null = null;
let currentSalt: Buffer | null = null;
let vaultPath: string = join(TITAN_HOME, 'vault.enc');

/**
 * Override the default vault file path (useful for tests or config).
 */
export function setVaultPath(path: string): void {
    vaultPath = path;
}

/**
 * Get the current vault file path.
 */
export function getVaultPath(): string {
    return vaultPath;
}

/**
 * Derive an AES-256 key from a passphrase and salt using PBKDF2.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST);
}

/**
 * Encrypt a plaintext string with a given key using AES-256-GCM.
 */
function encryptData(plaintext: string, key: Buffer): { iv: string; authTag: string; data: string } {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { iv: iv.toString('hex'), authTag, data: encrypted };
}

/**
 * Decrypt an encrypted payload with a given key using AES-256-GCM.
 */
function decryptData(payload: { iv: string; authTag: string; data: string }, key: Buffer): string {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
    let decrypted = decipher.update(payload.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Write the current in-memory secrets map to the vault file.
 */
function persistVault(): void {
    if (!secrets || !masterKey || !currentSalt) {
        throw new Error('Vault is not unlocked.');
    }

    const plaintext = JSON.stringify(Object.fromEntries(secrets));
    const encrypted = encryptData(plaintext, masterKey);

    const vaultFile: VaultFile = {
        salt: currentSalt.toString('hex'),
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        data: encrypted.data,
    };

    const dir = dirname(vaultPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    atomicWriteJsonFile(vaultPath, vaultFile);
    logger.debug(COMPONENT, 'Vault persisted to disk');
}

/**
 * Initialize a new vault with a passphrase.
 * Creates an empty vault file at the configured path.
 */
export function initVault(passphrase: string): void {
    if (!passphrase || passphrase.length === 0) {
        throw new Error('Passphrase must not be empty.');
    }

    const salt = randomBytes(SALT_LEN);
    const key = deriveKey(passphrase, salt);

    currentSalt = salt;
    masterKey = key;
    secrets = new Map();

    persistVault();
    logger.info(COMPONENT, `Vault initialized at ${vaultPath}`);
}

/**
 * Unlock an existing vault by decrypting it with the given passphrase.
 * Loads all secrets into memory.
 */
export function unlockVault(passphrase: string): void {
    if (!passphrase || passphrase.length === 0) {
        throw new Error('Passphrase must not be empty.');
    }

    if (!existsSync(vaultPath)) {
        throw new Error(`Vault file not found at ${vaultPath}. Run initVault first.`);
    }

    const raw = readFileSync(vaultPath, 'utf-8');
    let vaultFile: VaultFile;
    try {
        vaultFile = JSON.parse(raw) as VaultFile;
    } catch {
        throw new Error('Vault file is corrupted or not valid JSON.');
    }

    if (!vaultFile.salt || !vaultFile.iv || !vaultFile.authTag || !vaultFile.data) {
        throw new Error('Vault file is missing required fields.');
    }

    const salt = Buffer.from(vaultFile.salt, 'hex');
    const key = deriveKey(passphrase, salt);

    let plaintext: string;
    try {
        plaintext = decryptData(
            { iv: vaultFile.iv, authTag: vaultFile.authTag, data: vaultFile.data },
            key,
        );
    } catch {
        throw new Error('Failed to decrypt vault. Wrong passphrase or corrupted file.');
    }

    let parsed: Record<string, string>;
    try {
        parsed = JSON.parse(plaintext);
    } catch {
        throw new Error('Decrypted vault data is not valid JSON.');
    }

    currentSalt = salt;
    masterKey = key;
    secrets = new Map(Object.entries(parsed));

    logger.info(COMPONENT, `Vault unlocked — ${secrets.size} secret(s) loaded`);
}

/**
 * Add or update a secret in the vault. Vault must be unlocked.
 */
export function setSecret(name: string, value: string): void {
    if (!secrets) {
        throw new Error('Vault is locked. Unlock it first.');
    }
    if (!name || name.length === 0) {
        throw new Error('Secret name must not be empty.');
    }

    secrets.set(name, value);
    persistVault();
    logger.debug(COMPONENT, `Secret "${name}" set`);
}

/**
 * Retrieve a secret by name. Returns undefined if not found.
 * Vault must be unlocked.
 */
export function getSecret(name: string): string | undefined {
    if (!secrets) {
        return undefined;
    }
    return secrets.get(name);
}

/**
 * Delete a secret by name. Returns true if it existed, false otherwise.
 * Vault must be unlocked.
 */
export function deleteSecret(name: string): boolean {
    if (!secrets) {
        throw new Error('Vault is locked. Unlock it first.');
    }

    const existed = secrets.delete(name);
    if (existed) {
        persistVault();
        logger.debug(COMPONENT, `Secret "${name}" deleted`);
    }
    return existed;
}

/**
 * List all secret names. Returns empty array if vault is locked.
 */
export function listSecretNames(): string[] {
    if (!secrets) {
        return [];
    }
    return Array.from(secrets.keys());
}

/**
 * Lock the vault — clear all in-memory secrets and key material.
 */
export function lockVault(): void {
    if (secrets) {
        secrets.clear();
    }
    secrets = null;
    masterKey = null;
    currentSalt = null;
    logger.info(COMPONENT, 'Vault locked');
}

/**
 * Check if the vault is currently unlocked (secrets in memory).
 */
export function isVaultUnlocked(): boolean {
    return secrets !== null;
}
