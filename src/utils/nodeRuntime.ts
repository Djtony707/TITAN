/** Supported stable Node lines after the 2026-10-21 security releases. */
export const NODE_RUNTIME_RANGE = '^22.23.4 || ^24.22.1 || ^26.12.1';

const minimums: Record<number, readonly [number, number]> = {
    22: [23, 4],
    24: [22, 1],
    26: [12, 1],
};

export function isSupportedNodeRuntime(version: string = process.versions.node): boolean {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    if (![major, minor, patch].every(Number.isSafeInteger)) return false;
    const minimum = minimums[major];
    return !!minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]));
}

export function assertSecureNodeRuntime(version: string = process.versions.node): void {
    if (!isSupportedNodeRuntime(version)) {
        throw new Error(`Unsupported Node.js ${JSON.stringify(version)}. TITAN requires a patched stable runtime: ${NODE_RUNTIME_RANGE}.`);
    }
}
