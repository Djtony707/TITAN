/**
 * TITAN — Cron Skill (Built-in)
 * Schedule and manage automated tasks using node-cron.
 * Jobs are persisted to the DB and re-scheduled on gateway boot via initCronScheduler().
 */
import * as cron from 'node-cron';
import { exec } from 'child_process';
import { registerSkill } from '../registry.js';
import { getDb } from '../../memory/memory.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'Cron';

// ─── Active task handles ────────────────────────────────────────
// Maps job ID → node-cron ScheduledTask so we can stop/restart them.
const activeTasks = new Map<string, ReturnType<typeof cron.schedule>>();

// ─── Shell execution helper ─────────────────────────────────────

/** Execute a shell command and return its output (stdout + stderr). */
function executeCommand(command: string, timeout: number = 60000): Promise<string> {
    return new Promise((resolve) => {
        const proc = exec(
            command,
            {
                timeout,
                maxBuffer: 1024 * 1024 * 5, // 5 MB
                shell: '/bin/bash',
            },
            (error, stdout, stderr) => {
                let output = '';
                if (stdout) output += stdout;
                if (stderr) output += (output ? '\n' : '') + `[stderr] ${stderr}`;
                if (error) {
                    if (error.killed) {
                        output += (output ? '\n' : '') + `[timed out after ${timeout}ms]`;
                    } else {
                        output += (output ? '\n' : '') + `[exit code: ${error.code}]`;
                    }
                }
                // Truncate very long output so we don't bloat logs
                if (output.length > 10000) {
                    output = output.slice(0, 5000) + '\n... [truncated] ...\n' + output.slice(-5000);
                }
                resolve(output || '(no output)');
            },
        );
        void proc; // satisfy TS — proc is managed by exec callback
    });
}

// ─── Scheduler helpers ──────────────────────────────────────────

/** Start a node-cron task for a persisted job. Returns the task handle. */
function scheduleJob(jobId: string, schedule: string, command: string): ReturnType<typeof cron.schedule> | null {
    if (!cron.validate(schedule)) {
        logger.warn(COMPONENT, `Invalid cron expression for job ${jobId}: "${schedule}"`);
        return null;
    }

    const task = cron.schedule(schedule, async () => {
        logger.info(COMPONENT, `Running cron job ${jobId}: ${command}`);

        // Update last_run timestamp in the persisted store
        const store = getDb();
        const record = store.cronJobs.find((j) => j.id === jobId);
        if (record) {
            record.last_run = new Date().toISOString();
        }

        try {
            const output = await executeCommand(command);
            logger.info(COMPONENT, `Cron job ${jobId} completed:\n${output.slice(0, 500)}`);
        } catch (err) {
            logger.error(COMPONENT, `Cron job ${jobId} failed: ${(err as Error).message}`);
        }
    });

    return task;
}

/** Stop and remove a task from the active map. */
function stopAndRemoveTask(jobId: string): void {
    const task = activeTasks.get(jobId);
    if (task) {
        task.stop();
        activeTasks.delete(jobId);
        logger.debug(COMPONENT, `Stopped cron task: ${jobId}`);
    }
}

// ─── Public: init scheduler on gateway boot ─────────────────────

/**
 * Called once from server.ts on startup.
 * Reads all enabled cron jobs from the DB and schedules them.
 */
export function initCronScheduler(): void {
    const store = getDb();
    let scheduled = 0;
    let skipped = 0;

    for (const job of store.cronJobs) {
        if (!job.enabled) { skipped++; continue; }

        const task = scheduleJob(job.id, job.schedule, job.command);
        if (task) {
            activeTasks.set(job.id, task);
            scheduled++;
            logger.debug(COMPONENT, `Scheduled: "${job.name}" (${job.schedule})`);
        } else {
            skipped++;
        }
    }

    logger.info(COMPONENT, `Cron scheduler initialised — ${scheduled} active, ${skipped} skipped`);
}

// ─── Skill registration ─────────────────────────────────────────

export function registerCronSkill(): void {
    registerSkill(
        { name: 'cron', description: 'Schedule and manage recurring tasks using cron expressions. USE THIS WHEN Tony says: "schedule this to run every X", "set up a recurring task", "run this daily at 9am", "run this every 5 minutes", "add a cron job", "automate X on a schedule". WORKFLOW: action=create with name, schedule (cron expression), and shell command — action=list to see all jobs — action=enable/disable to toggle — action=delete to remove.', version: '1.1.0', source: 'bundled', enabled: true },
        {
            name: 'cron',
            description: 'Creates, lists, enables/disables, or deletes scheduled cron jobs. USE THIS WHEN Tony says: "schedule this to run every X", "set up a recurring task", "run this daily at 9am", "run every 5 minutes", "add a cron job", "automate X on a schedule", "stop that cron job". WORKFLOW: action=create (requires name, schedule as cron expression, command) — action=list to view all — action=enable/disable to toggle with jobId — action=delete with jobId to remove. RULES: Cron expressions format: "0 9 * * *" = daily at 9am, "*/5 * * * *" = every 5 min. Jobs survive restarts.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create', 'list', 'delete', 'enable', 'disable'],
                        description: 'Action to perform',
                    },
                    name: { type: 'string', description: 'Human-readable name for the cron job' },
                    schedule: {
                        type: 'string',
                        description: 'Cron schedule expression (e.g., "0 9 * * *" for daily at 9 am, "*/5 * * * *" every 5 min)',
                    },
                    command: { type: 'string', description: 'Shell command or task description to execute when the job runs' },
                    jobId: { type: 'string', description: 'Job ID (required for delete/enable/disable)' },
                    mode: { type: 'string', enum: ['shell', 'tool'], description: 'Execution mode: "shell" (default) runs a shell command, "tool" sends the command as a message to TITAN for tool-based execution' },
                    allowedTools: { type: 'string', description: 'Comma-separated list of allowed tool names for tool-mode jobs (e.g., "web_search,write_file,shell")' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const store = getDb();

                switch (action) {
                    // ── Create ─────────────────────────────────
                    case 'create': {
                        const name = args.name as string;
                        const schedule = args.schedule as string;
                        const command = args.command as string;

                        if (!name || !schedule || !command) {
                            return 'Error: name, schedule, and command are required for create';
                        }

                        if (!cron.validate(schedule)) {
                            return `Error: "${schedule}" is not a valid cron expression. Example: "0 9 * * *" (daily at 9 am)`;
                        }

                        const mode = (args.mode as string) === 'tool' ? 'tool' : 'shell';
                        const allowedToolsStr = args.allowedTools as string | undefined;
                        const allowedTools = allowedToolsStr ? allowedToolsStr.split(',').map(t => t.trim()).filter(Boolean) : undefined;

                        const id = uuid();
                        store.cronJobs.push({
                            id,
                            name,
                            schedule,
                            command,
                            mode: mode as 'shell' | 'tool',
                            allowedTools,
                            enabled: true,
                            created_at: new Date().toISOString(),
                        });

                        // Schedule immediately so it runs without a restart
                        const task = scheduleJob(id, schedule, command);
                        if (task) {
                            activeTasks.set(id, task);
                        }

                        logger.info(COMPONENT, `Created and scheduled cron job: ${name} (${schedule})`);
                        return `Created cron job "${name}" (ID: ${id})\nSchedule: ${schedule}\nCommand: ${command}\nStatus: Active and running`;
                    }

                    // ── List ──────────────────────────────────
                    case 'list': {
                        if (store.cronJobs.length === 0) return 'No cron jobs configured.';

                        return store.cronJobs.map((j) => {
                            const running = activeTasks.has(j.id) ? '(running)' : '(not scheduled)';
                            const lastRun = j.last_run ? `\n  Last run: ${j.last_run}` : '';
                            return [
                                `• ${j.name} [${j.enabled ? '✅ enabled' : '❌ disabled'}] ${running}`,
                                `  ID: ${j.id}`,
                                `  Schedule: ${j.schedule}`,
                                `  Command: ${j.command}`,
                                lastRun,
                            ].filter(Boolean).join('\n');
                        }).join('\n\n');
                    }

                    // ── Delete ────────────────────────────────
                    case 'delete': {
                        const jobId = args.jobId as string;
                        if (!jobId) return 'Error: jobId is required';

                        const job = store.cronJobs.find((j) => j.id === jobId);
                        if (!job) return `Error: no cron job found with ID: ${jobId}`;

                        // Stop the running task first
                        stopAndRemoveTask(jobId);

                        store.cronJobs = store.cronJobs.filter((j) => j.id !== jobId);
                        logger.info(COMPONENT, `Deleted cron job: ${job.name} (${jobId})`);
                        return `Deleted cron job "${job.name}" (ID: ${jobId})`;
                    }

                    // ── Enable ────────────────────────────────
                    case 'enable': {
                        const eId = args.jobId as string;
                        if (!eId) return 'Error: jobId is required';

                        const job = store.cronJobs.find((j) => j.id === eId);
                        if (!job) return `Error: no cron job found with ID: ${eId}`;

                        job.enabled = true;

                        // Start scheduling if not already active
                        if (!activeTasks.has(eId)) {
                            const task = scheduleJob(eId, job.schedule, job.command);
                            if (task) {
                                activeTasks.set(eId, task);
                            }
                        }

                        logger.info(COMPONENT, `Enabled cron job: ${job.name} (${eId})`);
                        return `Enabled cron job "${job.name}" — it will now run on schedule (${job.schedule})`;
                    }

                    // ── Disable ───────────────────────────────
                    case 'disable': {
                        const dId = args.jobId as string;
                        if (!dId) return 'Error: jobId is required';

                        const job = store.cronJobs.find((j) => j.id === dId);
                        if (!job) return `Error: no cron job found with ID: ${dId}`;

                        job.enabled = false;

                        // Stop the running task
                        stopAndRemoveTask(dId);

                        logger.info(COMPONENT, `Disabled cron job: ${job.name} (${dId})`);
                        return `Disabled cron job "${job.name}" — it will no longer run until re-enabled`;
                    }

                    default:
                        return `Unknown action: ${action}. Valid actions: create, list, delete, enable, disable`;
                }
            },
        },
    );
}
