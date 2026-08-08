import type { TaskCluster } from '../../src/agent/recognizeCluster.js';

type Assert<T extends true> = T;
type ForbiddenActions = 'compile' | 'promote' | 'select' | 'approve';
type NoForbiddenActions = Assert<
    Extract<keyof TaskCluster, ForbiddenActions> extends never ? true : false
>;

const typecheck: NoForbiddenActions = true;
void typecheck;
