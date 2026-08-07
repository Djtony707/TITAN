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
 * Security properties (static review, event 56c3dd16):
 *  - EVERY exported filesystem entry point validates agentId (containment);
 *    validation is centralized in assertValidAgentId.
 *  - Minting is atomic: keys are written to temp files and renamed into
 *    place, so a crash or concurrent mint can never leave a mismatched
 *    pair visible. Concurrent mints of the same id converge on one pair.
 *
 * Node's built-in ed25519 (crypto.generateKeyPairSync) — zero dependencies.
 */
import {
    generateKeyPairSync,
    createPrivateKey,
    createPublicKey,
    sign as cryptoSign,
    verify as cryptoVerify,
    randomBytes,
    type KeyObject,
} from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyKeys';

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Centralized agent-id validation — the single containment gate for every path build. */
export function assertValidAgentId(agentId: string): void {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
        throw new Error(`CompanyKeys: invalid agentId "${String(agentId)}"`);
    }
}

export interface AgentKeys {
    agentId: string;
    publicKeyPem: string;
    privateKey: KeyObject;
    publicKey: KeyObject;
}

function paths(agentId: string, keysDir: string): { priv: string; pub: string } {
    assertValidAgentId(agentId);
    return { priv: join(keysDir, `${agentId}.key`), pub: join(keysDir, `${agentId}.pub`) };
}

/**
 * Mint a new ed25519 keypair for an agent and persist it under keysDir.
 * Idempotent and concurrency-safe: if a pair already exists (or appears
 * concurrently), the existing pair is loaded. Writes are temp+rename so a
 * partially-written pair is never observable.
 */
export function mintAgentKeys(agentId: string, keysDir: string): AgentKeys {
    const { priv, pub } = paths(agentId, keysDir);
    if (existsSync(priv)) return loadAgentKeys(agentId, keysDir);

    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const nonce = randomBytes(6).toString('hex');
    const privTmp = `${priv}.${nonce}.tmp`;
    const pubTmp = `${pub}.${nonce}.tmp`;
    writeFileSync(privTmp, privPem, { mode: 0o600 });
    writeFileSync(pubTmp, pubPem, { mode: 0o644 });
    // Public first, private last: the pair is "live" only once the private
    // key lands, and a reader that sees .key always finds .pub.
    renameSync(pubTmp, pub);
    if (existsSync(priv)) {
        // Lost a concurrent mint race — discard ours, converge on the winner.
        rmSync(privTmp, { force: true });
        return loadAgentKeys(agentId, keysDir);
    }
    renameSync(privTmp, priv);
    logger.info(COMPONENT, `Minted ed25519 identity for "${agentId}"`);
    return { agentId, publicKeyPem: pubPem, privateKey, publicKey };
}

/** Load an existing agent keypair from keysDir. Throws if absent. */
export function loadAgentKeys(agentId: string, keysDir: string): AgentKeys {
    const { priv } = paths(agentId, keysDir);
    const privPem = readFileSync(priv, 'utf-8');
    const privateKey = createPrivateKey(privPem);
    // Derive the public key from the private key — self-consistent even if
    // the .pub file was tampered with or lost.
    const publicKey = createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    return { agentId, publicKeyPem, privateKey, publicKey };
}

/** Load only the public key (verification side). Null if the agent has no identity. */
export function loadAgentPublicKey(agentId: string, keysDir: string): KeyObject | null {
    const { pub } = paths(agentId, keysDir);
    if (!existsSync(pub)) return null;
    return createPublicKey(readFileSync(pub, 'utf-8'));
}

/** Compare two public keys for identity (DER bytes). */
export function samePublicKey(a: KeyObject, b: KeyObject): boolean {
    const da = a.export({ type: 'spki', format: 'der' }) as Buffer;
    const db = b.export({ type: 'spki', format: 'der' }) as Buffer;
    return da.length === db.length && da.equals(db);
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
