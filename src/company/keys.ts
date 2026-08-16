/**
 * TITAN — Company agent identity keys (v8 Slice 1)
 *
 * Each company agent (and the workspace/user principal) holds its own
 * ed25519 keypair. Every event appended to the company log is signed by
 * its actor's private key and verifiable against the stored public key.
 *
 * Storage (re-review fix, event cb5b802d): the WHOLE PAIR lives in ONE
 * file — <keysDir>/<agentId>.keypair (private PKCS8 PEM followed by
 * public SPKI PEM, mode 0600). Minting writes a temp file and renames it
 * into place. Because POSIX rename of a single file is atomic and the
 * pair never travels separately, no interleaving can split a pair. The
 * winner is elected with atomic NO-CLOBBER link(2): the FIRST minter to
 * link its temp pair into place wins; every later minter's link fails
 * with EEXIST, discards its own pair, and loads the winner. Every caller
 * therefore returns the registered on-disk identity — there is no window
 * where a caller holds a private key that is not the registered one
 * (re-review fix, event a760bf8a finding 2).
 *
 * Security properties:
 *  - EVERY exported filesystem entry point validates agentId (containment);
 *    validation is centralized in assertValidAgentId.
 *  - The public key is always DERIVED from the stored private key — a
 *    tampered or stale public half cannot exist by construction.
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, rmSync } from 'fs';
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

function pairPath(agentId: string, keysDir: string): string {
    assertValidAgentId(agentId);
    return join(keysDir, `${agentId}.keypair`);
}

function readPair(agentId: string, file: string): AgentKeys {
    const pem = readFileSync(file, 'utf-8');
    const privateKey = createPrivateKey(pem); // parses the first (private) PEM block
    const publicKey = createPublicKey(privateKey); // ALWAYS derived — no split-brain possible
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    return { agentId, publicKeyPem, privateKey, publicKey };
}

/**
 * Mint an ed25519 keypair for an agent. Idempotent and concurrency-safe:
 * the pair is written as ONE temp file renamed into place (atomic), and
 * the value RETURNED is always re-read from post-rename disk state, so
 * every concurrent caller converges on the same final pair.
 */
export function mintAgentKeys(agentId: string, keysDir: string): AgentKeys {
    const file = pairPath(agentId, keysDir);
    if (existsSync(file)) return readPair(agentId, file);

    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, privPem + pubPem, { mode: 0o600 });
    try {
        linkSync(tmp, file); // atomic NO-CLOBBER: first minter wins, forever
        logger.info(COMPONENT, `Minted ed25519 identity for "${agentId}"`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { rmSync(tmp, { force: true }); throw err; }
        // Lost the election — a concurrent minter linked first. Converge.
    } finally {
        rmSync(tmp, { force: true });
    }
    return readPair(agentId, file);
}

/** Load an existing agent keypair. Throws if absent. */
export function loadAgentKeys(agentId: string, keysDir: string): AgentKeys {
    return readPair(agentId, pairPath(agentId, keysDir));
}

/** Load only the public key (verification side). Null if the agent has no identity. */
export function loadAgentPublicKey(agentId: string, keysDir: string): KeyObject | null {
    const file = pairPath(agentId, keysDir);
    if (!existsSync(file)) return null;
    return readPair(agentId, file).publicKey;
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
