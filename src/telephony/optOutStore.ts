import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { hashPhoneForOptOut, normalizePhoneNumber, redactPhoneNumber } from './phonePolicy.js';

export interface TelephonyOptOut {
  phoneHash: string;
  optOutHash?: string;
  phoneRedacted: string;
  reason: string;
  source: 'dograh_inbound' | 'manual';
  recordedAt: string;
  callId?: string;
}

type StoreShape = { optOuts: TelephonyOptOut[] };

function titanHome(): string {
  const envHome = process.env.TITAN_HOME?.trim();
  if (envHome) {
    if (envHome === '~') return homedir();
    if (envHome.startsWith('~/')) return join(homedir(), envHome.slice(2));
    return envHome;
  }
  return join(homedir(), '.titan');
}

function storePath(): string {
  return join(titanHome(), 'telephony-opt-outs.json');
}

function readStore(): StoreShape {
  const path = storePath();
  if (!existsSync(path)) return { optOuts: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreShape>;
    return { optOuts: Array.isArray(raw.optOuts) ? raw.optOuts.filter(isOptOutRecord) : [] };
  } catch {
    return { optOuts: [] };
  }
}

function writeStore(store: StoreShape): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
}

function isOptOutRecord(value: unknown): value is TelephonyOptOut {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.phoneHash === 'string'
    && typeof record.phoneRedacted === 'string'
    && typeof record.reason === 'string'
    && typeof record.recordedAt === 'string';
}

export function listTelephonyOptOuts(): TelephonyOptOut[] {
  return readStore().optOuts.slice().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function isTelephonyOptedOut(phoneHash: string | undefined, optOutHash?: string): TelephonyOptOut | undefined {
  if (!phoneHash && !optOutHash) return undefined;
  return listTelephonyOptOuts().find((entry) =>
    (phoneHash ? entry.phoneHash === phoneHash : false) ||
    (optOutHash ? entry.optOutHash === optOutHash : false),
  );
}

export function recordTelephonyOptOut(opts: {
  phoneNumber: string;
  phoneHash: string;
  reason: string;
  source?: TelephonyOptOut['source'];
  callId?: string;
}): TelephonyOptOut {
  const normalized = normalizePhoneNumber(opts.phoneNumber) ?? opts.phoneNumber;
  const store = readStore();
  const optOutHash = hashPhoneForOptOut(normalized);
  const prior = store.optOuts.find((entry) => entry.phoneHash === opts.phoneHash || entry.optOutHash === optOutHash);
  if (prior) return prior;
  const entry: TelephonyOptOut = {
    phoneHash: opts.phoneHash,
    optOutHash,
    phoneRedacted: redactPhoneNumber(normalized),
    reason: opts.reason.slice(0, 160),
    source: opts.source ?? 'dograh_inbound',
    recordedAt: new Date().toISOString(),
    callId: opts.callId,
  };
  store.optOuts.push(entry);
  writeStore(store);
  return entry;
}
