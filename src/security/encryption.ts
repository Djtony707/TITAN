/**
 * TITAN — Encryption Module
 * Provides E2E encryption for sensitive sessions using AES-256-GCM.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import logger from '../utils/logger.js';

const COMPONENT = 'Encryption';
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;

function decodeHex(value: unknown, byteLength?: number): Buffer {
    if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(value)
        || (byteLength !== undefined && value.length !== byteLength * 2)) {
        throw new Error('Invalid encryption payload encoding.');
    }
    return Buffer.from(value, 'hex');
}

export interface EncryptedPayload {
    iv: string;
    authTag: string;
    data: string;
}

/**
 * Generates a strong 256-bit encryption key securely.
 */
export function generateKey(): Buffer {
    return randomBytes(32);
}

/**
 * Encrypts a string of text using AES-256-GCM.
 * @param text The plaintext to encrypt
 * @param key The 32-byte encryption key
 */
export function encrypt(text: string, key: Buffer | string): EncryptedPayload {
    try {
        const keyBuffer = typeof key === 'string' ? decodeHex(key, 32) : key;
        if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
            throw new Error('Encryption key must be exactly 32 bytes (256 bits).');
        }

        const iv = randomBytes(IV_LEN);
        const cipher = createCipheriv(ALGORITHM, keyBuffer, iv, { authTagLength: AUTH_TAG_LEN });

        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag().toString('hex');

        return {
            iv: iv.toString('hex'),
            authTag,
            data: encrypted
        };
    } catch (e: unknown) {
        logger.error(COMPONENT, `Encryption failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error('Failed to encrypt session data.');
    }
}

/**
 * Decrypts an EncryptedPayload back into plaintext text using AES-256-GCM.
 * @param payload The encrypted payload object (iv, authTag, data)
 * @param key The 32-byte encryption key
 */
export function decrypt(payload: EncryptedPayload, key: Buffer | string): string {
    try {
        const keyBuffer = typeof key === 'string' ? decodeHex(key, 32) : key;
        if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
            throw new Error('Decryption key must be exactly 32 bytes (256 bits).');
        }

        const iv = decodeHex(payload.iv, IV_LEN);
        const authTag = decodeHex(payload.authTag, AUTH_TAG_LEN);
        const data = decodeHex(payload.data);
        const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv, { authTagLength: AUTH_TAG_LEN });
        decipher.setAuthTag(authTag);

        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (e: unknown) {
        logger.error(COMPONENT, `Decryption failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error('Failed to decrypt session data. Invalid key or corrupted payload.');
    }
}
