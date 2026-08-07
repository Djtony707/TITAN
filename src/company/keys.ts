/**
 * TITAN — Company agent identity keys (v8 Slice 1)
 *
 * Each company agent (and the workspace/user principal) holds its own
 * ed25519 keypair. Every event appended to the company log is signed by
 * its actor's private key and verifiable against the stored public key.
 *
 * Storage: <keysDir>/<agentId>.key (private, PEM, mode 0600)
 *          <keysDir>/<agentId>.pub (public, PEM, mode 0644)
 *
 * Node's built-in ed25519 (crypto.generateKeyPairSync) — zero dependencies.
 */
import {
    generateKeyPairSync,
    createPrivateKey,
    createPublicKey,
    sign as cryptoSign,
    verify as cryptoVerify,
    type KeyObject,
} from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyKeys';

export interface AgentKeys {
    agentId: string;
    publicKeyPem: string;
    privateKey: KeyObject;
    publicKey: KeyObject;
}

/** Mint a new ed25519 keypair for an agent and persist it under keysDir. Idempotent: loads if present. */
export function mintAgentKeys(agentId: string, keysDir: string): AgentKeys {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId)) {
        throw new Error(`CompanyKeys: invalid agentId "${agentId}"`);
    }
    const privPath = join(keysDir, `${agentId}.key`);
    const pubPath = join(keysDir, `${agentId}.pub`);
    if (existsSync(privPath)) return loadAgentKeys(agentId, keysDir);

    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    writeFileSync(privPath, privPem, { mode: 0o600 });
    chmodSync(privPath, 0o600);
    writeFileSync(pubPath, pubPem, { mode: 0o644 });
    logger.info(COMPONENT, `Minted ed25519 identity for "${agentId}"`);
    return { agentId, publicKeyPem: pubPem, privateKey, publicKey };
}

/** Load an existing agent keypair from keysDir. Throws if absent. */
export function loadAgentKeys(agentId: string, keysDir: string): AgentKeys {
    const privPem = readFileSync(join(keysDir, `${agentId}.key`), 'utf-8');
    const pubPem = readFileSync(join(keysDir, `${agentId}.pub`), 'utf-8');
    return {
        agentId,
        publicKeyPem: pubPem,
        privateKey: createPrivateKey(privPem),
        publicKey: createPublicKey(pubPem),
    };
}

/** Load only the public key (verification side). */
export function loadAgentPublicKey(agentId: string, keysDir: string): KeyObject | null {
    const pubPath = join(keysDir, `${agentId}.pub`);
    if (!existsSync(pubPath)) return null;
    return createPublicKey(readFileSync(pubPath, 'utf-8'));
}

/** Sign a payload buffer with ed25519 (no digest — ed25519 is pure). */
export function signBytes(data: Buffer, privateKey: KeyObject): string {
    return cryptoSign(null, data, privateKey).toString('base64');
}

/** Verify an ed25519 signature. */
export function verifyBytes(data: Buffer, signatureB64: string, publicKey: KeyObject): boolean {
    try {
        return cryptoVerify(null, data, publicKey, Buffer.from(signatureB64, 'base64'));
    } catch {
        return false;
    }
}
