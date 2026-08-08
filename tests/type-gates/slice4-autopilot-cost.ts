import type { AutopilotRun } from '../../src/agent/autopilot.js';

type Assert<T extends true> = T;
type ForbiddenCostFields = 'estimatedCost' | 'projectedCost' | 'costEstimate';
type NoForbiddenCostFields = Assert<
    Extract<keyof AutopilotRun, ForbiddenCostFields> extends never ? true : false
>;

const typecheck: NoForbiddenCostFields = true;
void typecheck;
