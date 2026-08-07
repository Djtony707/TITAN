/**
 * TITAN — Company feature registration (v8 substrate, Honey D4).
 *
 * Thin re-export module. The actual `openCompanyFeature` implementation
 * lives in `src/substrate/eventLog.ts`, where the signing context, bus
 * emit, appendable kinds, and validator are ALL hardcoded. No public
 * function accepts caller-supplied trust material (signing, keysDir for
 * signing, legacy trust context). There is no exported registrar.
 *
 * This module exists to preserve the import path `./feature.js` for
 * `company/log.ts` and tests, and to re-export the types they need.
 */
export {
    openCompanyFeature,
    type CompanyFeatureOptions,
    type FeatureCapability,
    type SystemEvent,
    type SystemAppendContext,
    type SystemLifecycleValidator,
    type SigningContext,
} from '../substrate/eventLog.js';
export type { CompanyEventKind, CompanyEvent, AppendContext, LifecycleValidator } from './log.js';
export { EVENT_KINDS, QUEUE_KINDS, KNOWN_KINDS } from './log.js';
