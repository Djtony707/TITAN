/**
 * TITAN — Compiler feature registration (v8 substrate, Honey D4).
 *
 * Thin re-export module. The actual `openCompilerFeature` implementation
 * lives in `src/substrate/eventLog.ts`, where the signing context and
 * appendable kinds are ALL hardcoded. No public function accepts
 * caller-supplied trust material. There is no exported registrar.
 *
 * This module exists to preserve the import path `./feature.js` for tests
 * and consumers, and to re-export the types they need.
 */
export {
    openCompilerFeature,
    type CompilerFeatureOptions,
    type FeatureCapability,
    type SystemEvent,
    type SigningContext,
} from '../substrate/eventLog.js';
