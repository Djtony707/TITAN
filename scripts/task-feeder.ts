/**
 * Task Feeder — Populates the TITAN Command Post with work for specialist agents.
 * Run this after starting the gateway to seed the initial task queue.
 */

import { createIssue } from '../src/agent/commandPost.js';

const TASKS = [
    { title: 'Fix failing unit tests (subAgent maxRounds + Ollama chatStream)', assignee: 'tester', priority: 'high' as const },
    { title: 'Refactor agentLoop.ts into middleware architecture', assignee: 'builder', priority: 'high' as const },
    { title: 'Implement artifact store for large tool outputs', assignee: 'builder', priority: 'high' as const },
    { title: 'Update README with verified feature counts', assignee: 'docs', priority: 'medium' as const },
    { title: 'Review all 8 failing test files for root causes', assignee: 'reviewer', priority: 'high' as const },
    { title: 'Fix Docker build and verify container starts', assignee: 'devops', priority: 'high' as const },
    { title: 'Add harness-level tests (resumption, compaction, approval gates)', assignee: 'tester', priority: 'high' as const },
    { title: 'Wire voice server into gateway proxy routes', assignee: 'builder', priority: 'medium' as const },
];

async function feedTasks() {
    console.log('Feeding tasks to Command Post...');
    for (const task of TASKS) {
        try {
            await createIssue({
                title: task.title,
                assigneeAgentId: task.assignee,
                priority: task.priority,
                status: 'queued',
                createdBy: 'task-feeder',
            });
            console.log(`  ✓ Created: ${task.title} → ${task.assignee}`);
        } catch (err) {
            console.error(`  ✗ Failed: ${task.title}`, err);
        }
    }
    console.log('Done.');
}

feedTasks();
