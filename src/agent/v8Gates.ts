/**
 * TITAN v8 — Self-Compiling Agent feature-flag gates (Slice 6).
 *
 * Extracted from agent.ts and agentLoop.ts so the gate logic is testable
 * in isolation. Both production call sites and tests import these exact
 * functions — deleting a gate in production code breaks the test because
 * the test calls the same function, not a local re-simulation.
 *
 * The hard gate (Honey audit): flag-off = v7 byte-identical. With
 * selfCompiling.enabled false (the default), neither the TraceStore
 * (RECORD) nor the router middleware (ROUTE) activates.
 */

import type { TitanConfig } from '../config/schema.js';

/**
 * Whether the v8 TraceStore (Stage 1: RECORD) should activate.
 * Checks the master switch AND the record sub-flag.
 * {enabled:false, record:true} returns false — the master switch gates.
 */
export function shouldPersistTraces(config: TitanConfig): boolean {
    return !!(config.selfCompiling?.enabled && config.selfCompiling?.record);
}

/**
 * Whether the v8 router middleware (Stage 5: ROUTE) should activate.
 * Checks the master switch AND the route sub-flag.
 * {enabled:false, route:true} returns false — the master switch gates.
 */
export function shouldRoute(config: TitanConfig): boolean {
    return !!(config.selfCompiling?.enabled && config.selfCompiling?.route);
}

