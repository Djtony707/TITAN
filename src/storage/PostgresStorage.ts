/**
 * TITAN — PostgreSQL Storage Implementation
 * Full-fidelity implementation of StorageProvider using pg Pool.
 * Dynamic import ensures `pg` is only required when explicitly configured.
 */
import type { Pool, PoolClient } from 'pg';
import { TITAN_HOME } from '../utils/constants.js';
import { join } from 'path';
import logger from '../utils/logger.js';
import type {
    StorageProvider,
    IssueFilters,
    ActivityQueryOpts,
    BudgetReservation,
    Transaction,
} from './StorageProvider.js';
import type {
    TaskCheckout,
    BudgetPolicy,
    RegisteredAgent,
    ActivityEntry,
    CPIssue,
    CPComment,
    CPApproval,
    CPRun,
} from '../agent/commandPost.js';
import type { Goal, Subtask } from '../agent/goals.js';
import { runMigrations } from './migrator.js';

const COMPONENT = 'PostgresStorage';

// ─── PostgreSQL Transaction Wrapper ───────────────────────────────────────

class PgTransaction implements Transaction {
    constructor(private readonly client: PoolClient) {}

    async commit(): Promise<void> {
        await this.client.query('COMMIT');
        this.client.release();
    }

    async rollback(): Promise<void> {
        try {
            await this.client.query('ROLLBACK');
        } finally {
            this.client.release();
        }
    }
}

// ─── PostgresStorage Class ────────────────────────────────────────────────

export class PostgresStorage implements StorageProvider {
    private pool!: Pool;

    constructor(private readonly connectionString: string) {}

    // ── Lifecycle ────────────────────────────────────────────────────────

    async init(): Promise<void> {
        // Dynamic import so `pg` is only required when this class is instantiated
        const { Pool } = await import('pg');
        this.pool = new Pool({
            connectionString: this.connectionString,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        // Verify connectivity
        const client = await this.pool.connect();
        client.release();

        // Run SQL migrations from src/storage/migrations/
        await runMigrations(this.pool);

        logger.info(COMPONENT, 'PostgreSQL storage initialized');
    }

    async shutdown(): Promise<void> {
        await this.pool.end();
        logger.info(COMPONENT, 'PostgreSQL storage shut down');
    }

    // ── Transactions ──────────────────────────────────────────────────────

    async beginTransaction(): Promise<Transaction> {
        const client = await this.pool.connect();
        await client.query('BEGIN');
        return new PgTransaction(client);
    }

    // ── Goals ────────────────────────────────────────────────────────────

    async getGoals(): Promise<Goal[]> {
        const { rows } = await this.pool.query<Goal>(
            `SELECT
                id, title, description, status, priority,
                subtasks, schedule, budget_limit AS "budgetLimit",
                total_cost AS "totalCost", progress,
                created_at AS "createdAt", updated_at AS "updatedAt",
                completed_at AS "completedAt", tags,
                parent_goal_id AS "parentGoalId"
             FROM goals
             ORDER BY priority ASC, created_at ASC`
        );
        return rows.map(this.rowToGoal);
    }

    async getGoal(id: string): Promise<Goal | undefined> {
        const { rows } = await this.pool.query<Goal>(
            `SELECT
                id, title, description, status, priority,
                subtasks, schedule, budget_limit AS "budgetLimit",
                total_cost AS "totalCost", progress,
                created_at AS "createdAt", updated_at AS "updatedAt",
                completed_at AS "completedAt", tags,
                parent_goal_id AS "parentGoalId"
             FROM goals WHERE id = $1`,
            [id]
        );
        return rows[0] ? this.rowToGoal(rows[0]) : undefined;
    }

    async saveGoal(goal: Goal): Promise<void> {
        await this.pool.query(
            `INSERT INTO goals (
                id, title, description, status, priority,
                subtasks, schedule, budget_limit, total_cost, progress,
                created_at, updated_at, completed_at, tags, parent_goal_id
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (id) DO UPDATE SET
                title          = EXCLUDED.title,
                description    = EXCLUDED.description,
                status         = EXCLUDED.status,
                priority       = EXCLUDED.priority,
                subtasks       = EXCLUDED.subtasks,
                schedule       = EXCLUDED.schedule,
                budget_limit   = EXCLUDED.budget_limit,
                total_cost     = EXCLUDED.total_cost,
                progress       = EXCLUDED.progress,
                updated_at     = EXCLUDED.updated_at,
                completed_at   = EXCLUDED.completed_at,
                tags           = EXCLUDED.tags,
                parent_goal_id = EXCLUDED.parent_goal_id`,
            [
                goal.id, goal.title, goal.description, goal.status, goal.priority,
                JSON.stringify(goal.subtasks), goal.schedule ?? null,
                goal.budgetLimit ?? null, goal.totalCost, goal.progress,
                goal.createdAt, goal.updatedAt, goal.completedAt ?? null,
                JSON.stringify(goal.tags ?? []), goal.parentGoalId ?? null,
            ]
        );
    }

    async deleteGoal(id: string): Promise<boolean> {
        const { rowCount } = await this.pool.query('DELETE FROM goals WHERE id = $1', [id]);
        return (rowCount ?? 0) > 0;
    }

    async saveSubtask(goalId: string, subtask: Subtask): Promise<void> {
        // In PG mode subtasks live as JSONB on the goals row.
        // Fetch the goal, splice in the new subtask, re-save.
        const goal = await this.getGoal(goalId);
        if (!goal) return;
        const idx = goal.subtasks.findIndex(st => st.id === subtask.id);
        if (idx === -1) {
            goal.subtasks.push(subtask);
        } else {
            goal.subtasks[idx] = subtask;
        }
        await this.saveGoal(goal);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private rowToGoal(row: any): Goal {
        return {
            id:           row['id'] as string,
            title:        row['title'] as string,
            description:  row['description'] as string,
            status:       row['status'] as Goal['status'],
            priority:     row['priority'] as number,
            subtasks:     (typeof row['subtasks'] === 'string' ? JSON.parse(row['subtasks'] as string) : row['subtasks']) as Subtask[],
            schedule:     row['schedule'] as string | undefined ?? undefined,
            budgetLimit:  row['budgetLimit'] as number | undefined ?? undefined,
            totalCost:    row['totalCost'] as number,
            progress:     row['progress'] as number,
            createdAt:    row['createdAt'] as string,
            updatedAt:    row['updatedAt'] as string,
            completedAt:  row['completedAt'] as string | undefined ?? undefined,
            tags:         (typeof row['tags'] === 'string' ? JSON.parse(row['tags'] as string) : row['tags']) as string[] | undefined,
            parentGoalId: row['parentGoalId'] as string | undefined ?? undefined,
        };
    }

    // ── Agents ───────────────────────────────────────────────────────────

    async getAgents(): Promise<RegisteredAgent[]> {
        const { rows } = await this.pool.query(
            `SELECT
                id, name, model, status, last_heartbeat AS "lastHeartbeat",
                current_task_id AS "currentTaskId",
                total_tasks_completed AS "totalTasksCompleted",
                total_cost_usd AS "totalCostUsd",
                created_at AS "createdAt", reports_to AS "reportsTo",
                role, title
             FROM registered_agents ORDER BY created_at ASC`
        );
        return rows as RegisteredAgent[];
    }

    async getAgent(id: string): Promise<RegisteredAgent | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                id, name, model, status, last_heartbeat AS "lastHeartbeat",
                current_task_id AS "currentTaskId",
                total_tasks_completed AS "totalTasksCompleted",
                total_cost_usd AS "totalCostUsd",
                created_at AS "createdAt", reports_to AS "reportsTo",
                role, title
             FROM registered_agents WHERE id = $1`,
            [id]
        );
        return rows[0] as RegisteredAgent | undefined;
    }

    async saveAgent(agent: RegisteredAgent): Promise<void> {
        await this.pool.query(
            `INSERT INTO registered_agents (
                id, name, model, status, last_heartbeat,
                current_task_id, total_tasks_completed, total_cost_usd,
                created_at, reports_to, role, title
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (id) DO UPDATE SET
                name                  = EXCLUDED.name,
                model                 = EXCLUDED.model,
                status                = EXCLUDED.status,
                last_heartbeat        = EXCLUDED.last_heartbeat,
                current_task_id       = EXCLUDED.current_task_id,
                total_tasks_completed = EXCLUDED.total_tasks_completed,
                total_cost_usd        = EXCLUDED.total_cost_usd,
                reports_to            = EXCLUDED.reports_to,
                role                  = EXCLUDED.role,
                title                 = EXCLUDED.title`,
            [
                agent.id, agent.name, agent.model, agent.status, agent.lastHeartbeat,
                agent.currentTaskId ?? null, agent.totalTasksCompleted, agent.totalCostUsd,
                agent.createdAt, agent.reportsTo ?? null, agent.role, agent.title ?? null,
            ]
        );
    }

    async deleteAgent(id: string): Promise<boolean> {
        const { rowCount } = await this.pool.query('DELETE FROM registered_agents WHERE id = $1', [id]);
        return (rowCount ?? 0) > 0;
    }

    // ── Task Checkouts ────────────────────────────────────────────────────

    async getCheckouts(): Promise<TaskCheckout[]> {
        const { rows } = await this.pool.query(
            `SELECT
                subtask_id AS "subtaskId", goal_id AS "goalId",
                agent_id AS "agentId", run_id AS "runId",
                checked_out_at AS "checkedOutAt", expires_at AS "expiresAt",
                status
             FROM task_checkouts WHERE status = 'locked'`
        );
        return rows as TaskCheckout[];
    }

    async getCheckout(subtaskId: string): Promise<TaskCheckout | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                subtask_id AS "subtaskId", goal_id AS "goalId",
                agent_id AS "agentId", run_id AS "runId",
                checked_out_at AS "checkedOutAt", expires_at AS "expiresAt",
                status
             FROM task_checkouts WHERE subtask_id = $1`,
            [subtaskId]
        );
        return rows[0] as TaskCheckout | undefined;
    }

    async saveCheckout(checkout: TaskCheckout): Promise<void> {
        await this.pool.query(
            `INSERT INTO task_checkouts (
                subtask_id, goal_id, agent_id, run_id,
                checked_out_at, expires_at, status
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (subtask_id) DO UPDATE SET
                goal_id        = EXCLUDED.goal_id,
                agent_id       = EXCLUDED.agent_id,
                run_id         = EXCLUDED.run_id,
                checked_out_at = EXCLUDED.checked_out_at,
                expires_at     = EXCLUDED.expires_at,
                status         = EXCLUDED.status`,
            [
                checkout.subtaskId, checkout.goalId, checkout.agentId,
                checkout.runId, checkout.checkedOutAt, checkout.expiresAt,
                checkout.status,
            ]
        );
    }

    async deleteCheckout(subtaskId: string): Promise<void> {
        await this.pool.query('DELETE FROM task_checkouts WHERE subtask_id = $1', [subtaskId]);
    }

    // ── Budget Policies ───────────────────────────────────────────────────

    async getBudgetPolicies(): Promise<BudgetPolicy[]> {
        const { rows } = await this.pool.query(
            `SELECT
                id, name, scope, period, limit_usd AS "limitUsd",
                warning_threshold_percent AS "warningThresholdPercent",
                action, current_spend AS "currentSpend",
                period_start AS "periodStart", enabled
             FROM budget_policies ORDER BY name ASC`
        );
        return rows.map((r: any) => ({
            ...r,
            scope: typeof r.scope === 'string' ? JSON.parse(r.scope as string) : r.scope,
        })) as BudgetPolicy[];
    }

    async getBudgetPolicy(id: string): Promise<BudgetPolicy | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                id, name, scope, period, limit_usd AS "limitUsd",
                warning_threshold_percent AS "warningThresholdPercent",
                action, current_spend AS "currentSpend",
                period_start AS "periodStart", enabled
             FROM budget_policies WHERE id = $1`,
            [id]
        );
        if (!rows[0]) return undefined;
        const r = rows[0];
        return {
            ...r,
            scope: typeof r.scope === 'string' ? JSON.parse(r.scope as string) : r.scope,
        } as BudgetPolicy;
    }

    async saveBudgetPolicy(policy: BudgetPolicy): Promise<void> {
        await this.pool.query(
            `INSERT INTO budget_policies (
                id, name, scope, period, limit_usd,
                warning_threshold_percent, action,
                current_spend, period_start, enabled
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (id) DO UPDATE SET
                name                       = EXCLUDED.name,
                scope                      = EXCLUDED.scope,
                period                     = EXCLUDED.period,
                limit_usd                  = EXCLUDED.limit_usd,
                warning_threshold_percent  = EXCLUDED.warning_threshold_percent,
                action                     = EXCLUDED.action,
                current_spend              = EXCLUDED.current_spend,
                period_start               = EXCLUDED.period_start,
                enabled                    = EXCLUDED.enabled`,
            [
                policy.id, policy.name, JSON.stringify(policy.scope),
                policy.period, policy.limitUsd, policy.warningThresholdPercent,
                policy.action, policy.currentSpend, policy.periodStart, policy.enabled,
            ]
        );
    }

    async deleteBudgetPolicy(id: string): Promise<boolean> {
        const { rowCount } = await this.pool.query('DELETE FROM budget_policies WHERE id = $1', [id]);
        return (rowCount ?? 0) > 0;
    }

    // ── Issues ────────────────────────────────────────────────────────────

    async getIssues(): Promise<CPIssue[]> {
        const { rows } = await this.pool.query(
            `SELECT
                id, title, description, status, priority,
                assignee_agent_id AS "assigneeAgentId",
                created_by_agent_id AS "createdByAgentId",
                created_by_user AS "createdByUser",
                goal_id AS "goalId", parent_id AS "parentId",
                checkout_run_id AS "checkoutRunId",
                issue_number AS "issueNumber", identifier,
                created_at AS "createdAt", updated_at AS "updatedAt",
                started_at AS "startedAt", completed_at AS "completedAt"
             FROM issues ORDER BY updated_at DESC`
        );
        return rows as CPIssue[];
    }

    async getIssue(id: string): Promise<CPIssue | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                id, title, description, status, priority,
                assignee_agent_id AS "assigneeAgentId",
                created_by_agent_id AS "createdByAgentId",
                created_by_user AS "createdByUser",
                goal_id AS "goalId", parent_id AS "parentId",
                checkout_run_id AS "checkoutRunId",
                issue_number AS "issueNumber", identifier,
                created_at AS "createdAt", updated_at AS "updatedAt",
                started_at AS "startedAt", completed_at AS "completedAt"
             FROM issues WHERE id = $1`,
            [id]
        );
        return rows[0] as CPIssue | undefined;
    }

    async saveIssue(issue: CPIssue): Promise<void> {
        await this.pool.query(
            `INSERT INTO issues (
                id, title, description, status, priority,
                assignee_agent_id, created_by_agent_id, created_by_user,
                goal_id, parent_id, checkout_run_id,
                issue_number, identifier,
                created_at, updated_at, started_at, completed_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             ON CONFLICT (id) DO UPDATE SET
                title               = EXCLUDED.title,
                description         = EXCLUDED.description,
                status              = EXCLUDED.status,
                priority            = EXCLUDED.priority,
                assignee_agent_id   = EXCLUDED.assignee_agent_id,
                created_by_agent_id = EXCLUDED.created_by_agent_id,
                created_by_user     = EXCLUDED.created_by_user,
                goal_id             = EXCLUDED.goal_id,
                parent_id           = EXCLUDED.parent_id,
                checkout_run_id     = EXCLUDED.checkout_run_id,
                updated_at          = EXCLUDED.updated_at,
                started_at          = EXCLUDED.started_at,
                completed_at        = EXCLUDED.completed_at`,
            [
                issue.id, issue.title, issue.description, issue.status, issue.priority,
                issue.assigneeAgentId ?? null, issue.createdByAgentId ?? null,
                issue.createdByUser ?? null, issue.goalId ?? null,
                issue.parentId ?? null, issue.checkoutRunId ?? null,
                issue.issueNumber, issue.identifier,
                issue.createdAt, issue.updatedAt,
                issue.startedAt ?? null, issue.completedAt ?? null,
            ]
        );
    }

    async deleteIssue(id: string): Promise<boolean> {
        const { rowCount } = await this.pool.query('DELETE FROM issues WHERE id = $1', [id]);
        return (rowCount ?? 0) > 0;
    }

    async queryIssues(filters: IssueFilters): Promise<CPIssue[]> {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (filters.status) {
            params.push(filters.status);
            conditions.push(`status = $${params.length}`);
        }
        if (filters.assigneeAgentId) {
            params.push(filters.assigneeAgentId);
            conditions.push(`assignee_agent_id = $${params.length}`);
        }
        if (filters.goalId) {
            params.push(filters.goalId);
            conditions.push(`goal_id = $${params.length}`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows } = await this.pool.query(
            `SELECT
                id, title, description, status, priority,
                assignee_agent_id AS "assigneeAgentId",
                created_by_agent_id AS "createdByAgentId",
                created_by_user AS "createdByUser",
                goal_id AS "goalId", parent_id AS "parentId",
                checkout_run_id AS "checkoutRunId",
                issue_number AS "issueNumber", identifier,
                created_at AS "createdAt", updated_at AS "updatedAt",
                started_at AS "startedAt", completed_at AS "completedAt"
             FROM issues ${where} ORDER BY updated_at DESC`,
            params
        );
        return rows as CPIssue[];
    }

    // ── Issue Counter ─────────────────────────────────────────────────────

    async getIssueCounter(): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT value FROM kv_store WHERE key = 'issue_counter'`
        );
        return rows[0] ? parseInt(rows[0].value as string, 10) : 0;
    }

    async incrementIssueCounter(): Promise<number> {
        const { rows } = await this.pool.query(
            `INSERT INTO kv_store (key, value) VALUES ('issue_counter', '1')
             ON CONFLICT (key) DO UPDATE SET value = (CAST(kv_store.value AS INT) + 1)::TEXT
             RETURNING value`
        );
        return parseInt(rows[0].value as string, 10);
    }

    // ── Comments ──────────────────────────────────────────────────────────

    async getComments(issueId: string): Promise<CPComment[]> {
        const { rows } = await this.pool.query(
            `SELECT
                id, issue_id AS "issueId",
                author_agent_id AS "authorAgentId",
                author_user AS "authorUser",
                body, created_at AS "createdAt"
             FROM issue_comments WHERE issue_id = $1 ORDER BY created_at ASC`,
            [issueId]
        );
        return rows as CPComment[];
    }

    async saveComment(comment: CPComment): Promise<void> {
        await this.pool.query(
            `INSERT INTO issue_comments (
                id, issue_id, author_agent_id, author_user, body, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (id) DO UPDATE SET
                body       = EXCLUDED.body,
                created_at = EXCLUDED.created_at`,
            [
                comment.id, comment.issueId,
                comment.authorAgentId ?? null, comment.authorUser ?? null,
                comment.body, comment.createdAt,
            ]
        );
    }

    // ── Approvals ─────────────────────────────────────────────────────────

    async getApprovals(): Promise<CPApproval[]> {
        const { rows } = await this.pool.query(
            `SELECT
                id, type, status, requested_by AS "requestedBy",
                payload, decided_by AS "decidedBy",
                decided_at AS "decidedAt", decision_note AS "decisionNote",
                linked_issue_ids AS "linkedIssueIds",
                created_at AS "createdAt"
             FROM approvals ORDER BY created_at DESC`
        );
        return rows.map(this.rowToApproval);
    }

    async getApproval(id: string): Promise<CPApproval | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                id, type, status, requested_by AS "requestedBy",
                payload, decided_by AS "decidedBy",
                decided_at AS "decidedAt", decision_note AS "decisionNote",
                linked_issue_ids AS "linkedIssueIds",
                created_at AS "createdAt"
             FROM approvals WHERE id = $1`,
            [id]
        );
        return rows[0] ? this.rowToApproval(rows[0]) : undefined;
    }

    async saveApproval(approval: CPApproval): Promise<void> {
        await this.pool.query(
            `INSERT INTO approvals (
                id, type, status, requested_by, payload,
                decided_by, decided_at, decision_note,
                linked_issue_ids, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (id) DO UPDATE SET
                status           = EXCLUDED.status,
                decided_by       = EXCLUDED.decided_by,
                decided_at       = EXCLUDED.decided_at,
                decision_note    = EXCLUDED.decision_note,
                linked_issue_ids = EXCLUDED.linked_issue_ids`,
            [
                approval.id, approval.type, approval.status, approval.requestedBy,
                JSON.stringify(approval.payload),
                approval.decidedBy ?? null, approval.decidedAt ?? null,
                approval.decisionNote ?? null,
                JSON.stringify(approval.linkedIssueIds),
                approval.createdAt,
            ]
        );
    }

    private rowToApproval(row: Record<string, unknown>): CPApproval {
        return {
            id:            row['id'] as string,
            type:          row['type'] as CPApproval['type'],
            status:        row['status'] as CPApproval['status'],
            requestedBy:   row['requestedBy'] as string,
            payload:       typeof row['payload'] === 'string' ? JSON.parse(row['payload'] as string) : row['payload'] as Record<string, unknown>,
            decidedBy:     row['decidedBy'] as string | undefined ?? undefined,
            decidedAt:     row['decidedAt'] as string | undefined ?? undefined,
            decisionNote:  row['decisionNote'] as string | undefined ?? undefined,
            linkedIssueIds: typeof row['linkedIssueIds'] === 'string' ? JSON.parse(row['linkedIssueIds'] as string) : row['linkedIssueIds'] as string[],
            createdAt:     row['createdAt'] as string,
        };
    }

    // ── Runs ──────────────────────────────────────────────────────────────

    async getRuns(): Promise<CPRun[]> {
        const { rows } = await this.pool.query(
            `SELECT
                id, agent_id AS "agentId", source, status,
                issue_id AS "issueId",
                started_at AS "startedAt", finished_at AS "finishedAt",
                duration_ms AS "durationMs", tools_used AS "toolsUsed",
                token_usage AS "tokenUsage", error
             FROM runs ORDER BY started_at DESC LIMIT 500`
        );
        return rows.map(this.rowToRun);
    }

    async getRun(id: string): Promise<CPRun | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                id, agent_id AS "agentId", source, status,
                issue_id AS "issueId",
                started_at AS "startedAt", finished_at AS "finishedAt",
                duration_ms AS "durationMs", tools_used AS "toolsUsed",
                token_usage AS "tokenUsage", error
             FROM runs WHERE id = $1`,
            [id]
        );
        return rows[0] ? this.rowToRun(rows[0]) : undefined;
    }

    async saveRun(run: CPRun): Promise<void> {
        await this.pool.query(
            `INSERT INTO runs (
                id, agent_id, source, status, issue_id,
                started_at, finished_at, duration_ms,
                tools_used, token_usage, error
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE SET
                status      = EXCLUDED.status,
                finished_at = EXCLUDED.finished_at,
                duration_ms = EXCLUDED.duration_ms,
                tools_used  = EXCLUDED.tools_used,
                token_usage = EXCLUDED.token_usage,
                error       = EXCLUDED.error`,
            [
                run.id, run.agentId, run.source, run.status,
                run.issueId ?? null,
                run.startedAt, run.finishedAt ?? null,
                run.durationMs ?? null,
                JSON.stringify(run.toolsUsed),
                run.tokenUsage ? JSON.stringify(run.tokenUsage) : null,
                run.error ?? null,
            ]
        );
    }

    async queryRuns(agentId?: string, limit = 50): Promise<CPRun[]> {
        const params: unknown[] = [limit];
        const where = agentId ? `WHERE agent_id = $2` : '';
        if (agentId) params.push(agentId);

        const { rows } = await this.pool.query(
            `SELECT
                id, agent_id AS "agentId", source, status,
                issue_id AS "issueId",
                started_at AS "startedAt", finished_at AS "finishedAt",
                duration_ms AS "durationMs", tools_used AS "toolsUsed",
                token_usage AS "tokenUsage", error
             FROM runs ${where} ORDER BY started_at DESC LIMIT $1`,
            params
        );
        return rows.map(this.rowToRun);
    }

    private rowToRun(row: Record<string, unknown>): CPRun {
        return {
            id:          row['id'] as string,
            agentId:     row['agentId'] as string,
            source:      row['source'] as CPRun['source'],
            status:      row['status'] as CPRun['status'],
            issueId:     row['issueId'] as string | undefined ?? undefined,
            startedAt:   row['startedAt'] as string,
            finishedAt:  row['finishedAt'] as string | undefined ?? undefined,
            durationMs:  row['durationMs'] as number | undefined ?? undefined,
            toolsUsed:   typeof row['toolsUsed'] === 'string' ? JSON.parse(row['toolsUsed'] as string) : row['toolsUsed'] as string[],
            tokenUsage:  row['tokenUsage'] ? (typeof row['tokenUsage'] === 'string' ? JSON.parse(row['tokenUsage'] as string) : row['tokenUsage']) as CPRun['tokenUsage'] : undefined,
            error:       row['error'] as string | undefined ?? undefined,
        };
    }

    // ── Activity ──────────────────────────────────────────────────────────

    async appendActivity(entry: ActivityEntry): Promise<void> {
        await this.pool.query(
            `INSERT INTO activity (
                id, timestamp, type, agent_id, goal_id, message, metadata
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
                entry.id, entry.timestamp, entry.type,
                entry.agentId ?? null, entry.goalId ?? null,
                entry.message,
                entry.metadata ? JSON.stringify(entry.metadata) : null,
            ]
        );
    }

    async queryActivity(opts: ActivityQueryOpts): Promise<ActivityEntry[]> {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (opts.type) {
            params.push(opts.type);
            conditions.push(`type = $${params.length}`);
        }

        const limit = opts.limit ?? 500;
        params.push(limit);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const { rows } = await this.pool.query(
            `SELECT
                id, timestamp, type,
                agent_id AS "agentId", goal_id AS "goalId",
                message, metadata
             FROM activity ${where} ORDER BY timestamp DESC LIMIT $${params.length}`,
            params
        );
        return rows.map((r: any) => ({
            ...r,
            metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata as string) : r.metadata) : undefined,
        })) as ActivityEntry[];
    }

    // ── Budget Reservations ───────────────────────────────────────────────

    async saveBudgetReservation(reservation: BudgetReservation): Promise<void> {
        await this.pool.query(
            `INSERT INTO budget_reservations (
                id, policy_id, agent_id, goal_id,
                amount_usd, reserved_at, released_at, status
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO UPDATE SET
                released_at = EXCLUDED.released_at,
                status      = EXCLUDED.status`,
            [
                reservation.id, reservation.policyId, reservation.agentId,
                reservation.goalId ?? null, reservation.amountUsd,
                reservation.reservedAt, reservation.releasedAt ?? null,
                reservation.status,
            ]
        );
    }

    async getBudgetReservation(id: string): Promise<BudgetReservation | undefined> {
        const { rows } = await this.pool.query(
            `SELECT
                id, policy_id AS "policyId", agent_id AS "agentId",
                goal_id AS "goalId", amount_usd AS "amountUsd",
                reserved_at AS "reservedAt", released_at AS "releasedAt",
                status
             FROM budget_reservations WHERE id = $1`,
            [id]
        );
        return rows[0] as BudgetReservation | undefined;
    }
}
