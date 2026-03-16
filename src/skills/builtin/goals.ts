/**
 * TITAN — Goals Skill (Built-in)
 * LLM-invocable tools for creating, listing, updating, and deleting goals.
 * Wired to the goal management system in agent/goals.ts.
 */
import { registerSkill } from '../registry.js';
import {
    createGoal,
    listGoals,
    updateGoal,
    deleteGoal,
    getGoalsSummary,
    addSubtask,
    type GoalStatus,
} from '../../agent/goals.js';

export function registerGoalsSkill(): void {
    // Tool 1: goal_create
    registerSkill(
        {
            name: 'goals',
            description: 'Goal management — create, track, and complete long-running objectives. USE THIS WHEN Tony says: "set a goal", "I want to achieve X", "track this", "add a goal", "create a new objective".',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'goal_create',
            description: 'Creates a new goal with optional subtasks and schedule. USE THIS WHEN Tony says: "set a goal", "I want to achieve X", "add a new goal", "create an objective", "track this goal". Goals persist across sessions and drive autopilot cycles. RULES: Always provide a clear title and description. Optionally add subtasks as a JSON array.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Short goal title (e.g., "Publish 2 articles/week")',
                    },
                    description: {
                        type: 'string',
                        description: 'Detailed description of the goal',
                    },
                    priority: {
                        type: 'number',
                        description: 'Priority (1 = highest, default: auto)',
                    },
                    schedule: {
                        type: 'string',
                        description: 'Cron expression for recurring execution (e.g., "0 9 * * 1,4" for Mon+Thu 9am)',
                    },
                    budgetLimit: {
                        type: 'number',
                        description: 'Maximum USD to spend on this goal',
                    },
                    subtasks: {
                        type: 'string',
                        description: 'JSON array of subtasks: [{"title": "...", "description": "..."}]',
                    },
                },
                required: ['title', 'description'],
            },
            execute: async (args) => {
                try {
                    let subtasks: Array<{ title: string; description: string }> = [];
                    if (args.subtasks) {
                        try {
                            subtasks = JSON.parse(args.subtasks as string);
                        } catch {
                            return 'Error: subtasks must be valid JSON array of {title, description} objects';
                        }
                    }

                    const goal = createGoal({
                        title: args.title as string,
                        description: args.description as string,
                        priority: args.priority as number | undefined,
                        schedule: args.schedule as string | undefined,
                        budgetLimit: args.budgetLimit as number | undefined,
                        subtasks,
                    });

                    const lines = [
                        `Goal created: "${goal.title}" (ID: ${goal.id})`,
                        `Status: ${goal.status}`,
                        `Priority: ${goal.priority}`,
                        `Subtasks: ${goal.subtasks.length}`,
                    ];
                    if (goal.schedule) lines.push(`Schedule: ${goal.schedule}`);
                    if (goal.budgetLimit) lines.push(`Budget limit: $${goal.budgetLimit}`);

                    return lines.join('\n');
                } catch (e) {
                    return `Error creating goal: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: goal_list
    registerSkill(
        {
            name: 'goals',
            description: 'Goal management — list, track, and review long-running objectives. USE THIS WHEN Tony says: "what are my goals", "show my goals", "list active goals", "what am I working on".',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'goal_list',
            description: 'Lists all goals with their progress and status. USE THIS WHEN Tony says: "what are my goals", "show my goals", "list active goals", "what am I working on", "show goal progress". Optionally filter by status (active, paused, completed, failed).',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        description: 'Filter by status: "active", "paused", "completed", "failed" (default: all)',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const status = args.status as GoalStatus | undefined;
                    const goals = listGoals(status);

                    if (goals.length === 0) {
                        return status
                            ? `No goals with status "${status}".`
                            : 'No goals defined. Use goal_create to create one.';
                    }

                    return getGoalsSummary();
                } catch (e) {
                    return `Error listing goals: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: goal_update
    registerSkill(
        {
            name: 'goals',
            description: 'Goal management — update progress and status on existing objectives. USE THIS WHEN Tony says: "update goal progress", "mark goal as complete", "pause this goal", "set progress to X%".',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'goal_update',
            description: 'Updates a goal\'s status, progress, priority, or adds subtasks. USE THIS WHEN Tony says: "update goal progress", "mark goal as complete", "pause this goal", "set progress to X%", "add a subtask to goal X", "change priority of goal Y". WORKFLOW: Use goal_list first to get the goal ID, then call goal_update with id and the fields to change.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Goal ID to update',
                    },
                    status: {
                        type: 'string',
                        description: 'New status: "active", "paused", "completed", "failed"',
                    },
                    progress: {
                        type: 'number',
                        description: 'Progress percentage (0-100)',
                    },
                    priority: {
                        type: 'number',
                        description: 'New priority (1 = highest)',
                    },
                    addSubtask: {
                        type: 'string',
                        description: 'JSON object to add a subtask: {"title": "...", "description": "..."}',
                    },
                },
                required: ['id'],
            },
            execute: async (args) => {
                try {
                    const goalId = args.id as string;

                    // Handle adding a subtask
                    if (args.addSubtask) {
                        try {
                            const st = JSON.parse(args.addSubtask as string);
                            const subtask = addSubtask(goalId, st.title, st.description);
                            if (!subtask) return `Error: Goal "${goalId}" not found.`;
                            return `Subtask added: "${subtask.title}" (${subtask.id})`;
                        } catch {
                            return 'Error: addSubtask must be valid JSON {"title": "...", "description": "..."}';
                        }
                    }

                    const updates: Record<string, unknown> = {};
                    if (args.status) updates.status = args.status;
                    if (args.progress !== undefined) updates.progress = args.progress;
                    if (args.priority !== undefined) updates.priority = args.priority;

                    const goal = updateGoal(goalId, updates as Parameters<typeof updateGoal>[1]);
                    if (!goal) return `Error: Goal "${goalId}" not found.`;

                    return `Goal updated: "${goal.title}" — status: ${goal.status}, progress: ${goal.progress}%`;
                } catch (e) {
                    return `Error updating goal: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 4: goal_delete
    registerSkill(
        {
            name: 'goals',
            description: 'Goal management — delete goals and their subtasks. USE THIS WHEN Tony says: "delete this goal", "remove goal X", "get rid of that objective".',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'goal_delete',
            description: 'Deletes a goal and all its subtasks permanently. USE THIS WHEN Tony says: "delete this goal", "remove goal X", "get rid of that objective", "cancel goal Y". WORKFLOW: Use goal_list first to get the goal ID, then call goal_delete with the id.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Goal ID to delete',
                    },
                },
                required: ['id'],
            },
            execute: async (args) => {
                try {
                    const goalId = args.id as string;
                    const deleted = deleteGoal(goalId);
                    if (!deleted) return `Error: Goal "${goalId}" not found.`;
                    return `Goal deleted: ${goalId}`;
                } catch (e) {
                    return `Error deleting goal: ${(e as Error).message}`;
                }
            },
        },
    );
}
