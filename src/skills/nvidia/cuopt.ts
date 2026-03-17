/**
 * NVIDIA Skill: cuOpt GPU-Accelerated Optimization
 * Solve routing, scheduling, and mathematical optimization problems
 * using NVIDIA cuOpt (Apache-2.0).
 *
 * API: Async — POST /cuopt/request → poll GET /cuopt/solution/{reqId}
 * Requires cuOpt server running (Docker or pip install cuopt-server).
 * Config: nvidia.cuopt.url (default: http://localhost:5000)
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'NVIDIACuOpt';
const CLIENT_VERSION = '26.02';

function getCuOptUrl(): string {
    const config = loadConfig();
    const nvidia = (config as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const cuopt = nvidia?.cuopt as Record<string, unknown> | undefined;
    return (cuopt?.url as string) || 'http://localhost:5000';
}

/** Poll cuOpt for a solution, with backoff */
async function pollSolution(baseUrl: string, reqId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const start = Date.now();
    let delay = 100; // start polling at 100ms

    while (Date.now() - start < timeoutMs) {
        const resp = await fetch(`${baseUrl}/cuopt/solution/${reqId}`, {
            headers: {
                'Accept': 'application/json',
                'CLIENT-VERSION': CLIENT_VERSION,
            },
            signal: AbortSignal.timeout(10_000),
        });

        if (resp.status === 200) {
            return await resp.json() as Record<string, unknown>;
        }

        if (resp.status === 202) {
            // Still processing — wait and retry
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 1.5, 2000); // backoff up to 2s
            continue;
        }

        // Unexpected status
        const text = await resp.text();
        throw new Error(`cuOpt poll error (${resp.status}): ${text}`);
    }

    throw new Error(`cuOpt solve timed out after ${timeoutMs / 1000}s`);
}

export function register(): void {
    registerSkill({
        name: 'nvidia_cuopt',
        description: 'NVIDIA cuOpt — GPU-accelerated optimization for routing, scheduling, and mathematical programming',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'nvidia_cuopt_solve',
        description: `Solve optimization problems using NVIDIA cuOpt GPU-accelerated solver.

Supports:
- Vehicle Routing Problems (VRP) — fleet routing, pickup/delivery, time windows
- Mixed Integer Linear Programming (MILP) — scheduling, resource allocation
- Linear Programming (LP) — continuous optimization

cuOpt v26.02 uses an async API: submit problem → poll for solution.

VRP example JSON:
{
  "cost_matrix_data": {"data": {"0": [[0,1,2],[1,0,1],[2,1,0]]}},
  "fleet_data": {"vehicle_locations": [[0,0]], "capacities": [[10]], "vehicle_time_windows": [[0,100]]},
  "task_data": {"task_locations": [1,2], "demand": [[3,4]], "task_time_windows": [[0,50],[0,50]], "service_times": [5,5]},
  "solver_config": {"time_limit": 5}
}

Key fields:
- cost_matrix_data.data["0"] — 2D distance/time matrix indexed by location
- fleet_data.vehicle_locations — [[start, end]] location index pairs per vehicle
- task_data.task_locations — location index per task (references cost matrix)
- task_data.demand — [[demand_per_task]] per capacity dimension
- solver_config.time_limit — max solve seconds`,
        parameters: {
            type: 'object',
            properties: {
                problem: {
                    type: 'string',
                    description: 'Problem definition as JSON string (cuOpt v26 API format). Must include cost_matrix_data, fleet_data, task_data. Optional solver_config.',
                },
                timeoutSeconds: {
                    type: 'number',
                    description: 'Max time to wait for solution in seconds. Default: 30.',
                    default: 30,
                },
            },
            required: ['problem'],
        },
        execute: async (args: Record<string, unknown>) => {
            const problemStr = args.problem as string;
            const timeout = (args.timeoutSeconds as number) || 30;
            const baseUrl = getCuOptUrl();

            let problemData: Record<string, unknown>;
            try {
                problemData = JSON.parse(problemStr);
            } catch {
                return 'Error: Invalid JSON in problem definition. Provide valid JSON matching cuOpt v26 API format.';
            }

            // Add solver config if not present
            if (!problemData.solver_config) {
                problemData.solver_config = {
                    time_limit: timeout,
                };
            }

            const endpoint = `${baseUrl}/cuopt/request`;
            logger.info(COMPONENT, `Submitting optimization problem to ${endpoint} (timeout: ${timeout}s)`);

            try {
                // Step 1: Submit problem
                const submitResp = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'CLIENT-VERSION': CLIENT_VERSION,
                    },
                    body: JSON.stringify(problemData),
                    signal: AbortSignal.timeout(15_000),
                });

                if (!submitResp.ok) {
                    const errorText = await submitResp.text();
                    return `cuOpt submit error (${submitResp.status}): ${errorText}`;
                }

                const submitResult = await submitResp.json() as Record<string, unknown>;
                const reqId = submitResult.reqId as string;
                if (!reqId) {
                    return `cuOpt error: No reqId returned. Response: ${JSON.stringify(submitResult)}`;
                }

                logger.info(COMPONENT, `Problem submitted, reqId=${reqId}. Polling for solution...`);

                // Step 2: Poll for solution
                const solution = await pollSolution(baseUrl, reqId, timeout * 1000);

                // Extract useful info from response
                const response = solution.response as Record<string, unknown> | undefined;
                const solverResp = response?.solver_response as Record<string, unknown> | undefined;
                const solveTime = response?.total_solve_time as number | undefined;

                if (solverResp) {
                    const cost = (solverResp.objective_values as Record<string, number>)?.cost ?? solverResp.solution_cost;
                    const numVehicles = solverResp.num_vehicles;
                    const dropped = (solverResp.dropped_tasks as Record<string, unknown[]>)?.task_id?.length || 0;

                    let summary = `cuOpt Solution (solved in ${solveTime?.toFixed(3) ?? '?'}s):\n`;
                    summary += `- Cost: ${cost}\n`;
                    if (numVehicles !== undefined) summary += `- Vehicles used: ${numVehicles}\n`;
                    if (dropped > 0) summary += `- ⚠️ Dropped tasks: ${dropped}\n`;
                    summary += `\n\`\`\`json\n${JSON.stringify(solution, null, 2)}\n\`\`\``;
                    return summary;
                }

                return `cuOpt Solution:\n\`\`\`json\n${JSON.stringify(solution, null, 2)}\n\`\`\``;
            } catch (err) {
                const msg = (err as Error).message;
                if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
                    return `Error: cuOpt server not reachable at ${baseUrl}. Start it with:\n  docker compose -f docker-compose.nvidia.yml --profile cuopt up -d`;
                }
                if (msg.includes('timed out')) {
                    return `Error: cuOpt solve timed out after ${timeout}s. Try increasing timeoutSeconds or simplifying the problem.`;
                }
                return `cuOpt error: ${msg}`;
            }
        },
    });

    // Register health check tool
    registerSkill({
        name: 'nvidia_cuopt_health',
        description: 'Check NVIDIA cuOpt server health',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'nvidia_cuopt_health',
        description: 'Check if the NVIDIA cuOpt optimization server is running and healthy.',
        parameters: {
            type: 'object',
            properties: {},
        },
        execute: async () => {
            const baseUrl = getCuOptUrl();
            try {
                const response = await fetch(`${baseUrl}/`, {
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(5000),
                });
                if (response.ok) {
                    const data = await response.json() as Record<string, unknown>;
                    return `cuOpt server is healthy at ${baseUrl} — status: ${data.status}, version: ${data.version}`;
                }
                return `cuOpt server returned status ${response.status} at ${baseUrl}`;
            } catch {
                return `cuOpt server not reachable at ${baseUrl}. Start it with:\n  docker compose -f docker-compose.nvidia.yml --profile cuopt up -d`;
            }
        },
    });
}
