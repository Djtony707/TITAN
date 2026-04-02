/**
 * TITAN — External Agent Adapter Registry
 *
 * Central registry for all external agent adapters. Adapters are auto-registered
 * on import. Use `getAdapter(type)` to retrieve one by type string.
 */
import type { ExternalAdapter } from './base.js';
import { claudeCodeAdapter } from './claudeCode.js';
import { codexAdapter } from './codex.js';
import { bashAdapter } from './bash.js';

export type { ExternalAdapter, AdapterContext, AdapterResult } from './base.js';

// ── Registry ──────────────────────────────────────────────────────────

const adapters = new Map<string, ExternalAdapter>();

/** Register an adapter (for plugins to add custom adapters) */
export function registerAdapter(adapter: ExternalAdapter): void {
    adapters.set(adapter.type, adapter);
}

/** Get an adapter by type string */
export function getAdapter(type: string): ExternalAdapter | null {
    return adapters.get(type) || null;
}

/** List all registered adapter types */
export function listAdapters(): string[] {
    return [...adapters.keys()];
}

// ── Auto-register built-in adapters ───────────────────────────────────

registerAdapter(claudeCodeAdapter);
registerAdapter(codexAdapter);
registerAdapter(bashAdapter);
