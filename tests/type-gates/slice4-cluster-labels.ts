import type { TaskCluster } from '../../src/agent/recognizeCluster.js';

type Assert<T extends true> = T;
type ForbiddenLabels = '_confidence' | 'confidence' | 'estimated' | 'measured';
type NoForbiddenLabels = Assert<
    Extract<keyof TaskCluster, ForbiddenLabels> extends never ? true : false
>;

const typecheck: NoForbiddenLabels = true;
void typecheck;
