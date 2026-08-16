/**
 * TITAN — Company layer runtime compatibility gate (v8 Slice 1)
 *
 * The company substrate uses node:sqlite, which runs unflagged only on
 * Node >= 22.13.0. The PRODUCT still supports the v7 engines floor
 * (>= 22.0.0) when the company layer is disabled — so the version gate
 * lives HERE, at company activation time, not in package.json engines.
 *
 * Callers (service/router) must check this BEFORE importing ./log.js:
 * on older Node the node:sqlite import itself would throw.
 */

export const COMPANY_MIN_NODE = '22.13.0';

/** Is the current runtime new enough for the company layer? */
export function companyRuntimeSupported(nodeVersion: string = process.versions.node): boolean {
    const parse = (v: string): number[] => v.split('.').map(n => parseInt(n, 10) || 0);
    const [maj, min, pat] = parse(nodeVersion);
    const [rMaj, rMin, rPat] = parse(COMPANY_MIN_NODE);
    if (maj !== rMaj) return maj > rMaj;
    if (min !== rMin) return min > rMin;
    return pat >= rPat;
}

/** Throw a clear, actionable error when the runtime is too old. */
export function assertCompanyRuntime(nodeVersion: string = process.versions.node): void {
    if (!companyRuntimeSupported(nodeVersion)) {
        throw new Error(
            `The v8 company layer requires Node >= ${COMPANY_MIN_NODE} (node:sqlite); ` +
            `this runtime is ${nodeVersion}. TITAN keeps working with company.enabled=false.`,
        );
    }
}
