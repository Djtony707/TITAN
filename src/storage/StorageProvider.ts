/**
 * TITAN — Storage Provider Interface
 * Abstract contract for all persistence backends (JSON files, PostgreSQL, etc.).
 * Every method is async so implementations can await I/O without callers changing.
 */
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

// ─── Query Filter Types ────────────────────────────────────────────────────

export interface IssueFilters {
    status?: string;
    assigneeAgentId?: string;
    goalId?: string;
}

export interface ActivityQueryOpts {
    limit?: number;
    type?: string;
}

// ─── Budget Reservation (optional — used by PostgresStorage for atomic spend) ──

export interface BudgetReservation {
    id: string;
    policyId: string;
    agentId: string;
    goalId?: string;
    amountUsd: number;
    reservedAt: string;
    releasedAt?: string;
    status: 'held' | 'committed' | 'released';
}

// ─── Transaction Handle ────────────────────────────────────────────────────

export interface Transaction {
    /** Commit the transaction */
    commit(): Promise<void>;
    /** Roll back the transaction */
    rollback(): Promise<void>;
}

// ─── StorageProvider Interface ─────────────────────────────────────────────

export interface StorageProvider {

    // ── Lifecycle ────────────────────────────────────────────────────────

    /** Open connections, run migrations, warm caches */
    init(): Promise<void>;

    /** Flush writes and close connections */
    shutdown(): Promise<void>;

    // ── Goals ────────────────────────────────────────────────────────────

    getGoals(): Promise<Goal[]>;
    getGoal(id: string): Promise<Goal | undefined>;
    saveGoal(goal: Goal): Promise<void>;
    deleteGoal(id: string): Promise<boolean>;

    // ── Subtasks (stored inline on Goal in JSON; separate row in PG) ─────

    saveSubtask(goalId: string, subtask: Subtask): Promise<void>;

    // ── Agents ───────────────────────────────────────────────────────────

    getAgents(): Promise<RegisteredAgent[]>;
    getAgent(id: string): Promise<RegisteredAgent | undefined>;
    saveAgent(agent: RegisteredAgent): Promise<void>;
    deleteAgent(id: string): Promise<boolean>;

    // ── Task Checkouts ────────────────────────────────────────────────────

    getCheckouts(): Promise<TaskCheckout[]>;
    getCheckout(subtaskId: string): Promise<TaskCheckout | undefined>;
    saveCheckout(checkout: TaskCheckout): Promise<void>;
    deleteCheckout(subtaskId: string): Promise<void>;

    // ── Budget Policies ───────────────────────────────────────────────────

    getBudgetPolicies(): Promise<BudgetPolicy[]>;
    getBudgetPolicy(id: string): Promise<BudgetPolicy | undefined>;
    saveBudgetPolicy(policy: BudgetPolicy): Promise<void>;
    deleteBudgetPolicy(id: string): Promise<boolean>;

    // ── Issues ────────────────────────────────────────────────────────────

    getIssues(): Promise<CPIssue[]>;
    getIssue(id: string): Promise<CPIssue | undefined>;
    saveIssue(issue: CPIssue): Promise<void>;
    deleteIssue(id: string): Promise<boolean>;
    queryIssues(filters: IssueFilters): Promise<CPIssue[]>;

    // ── Issue Counter ─────────────────────────────────────────────────────

    getIssueCounter(): Promise<number>;
    incrementIssueCounter(): Promise<number>;

    // ── Comments ──────────────────────────────────────────────────────────

    getComments(issueId: string): Promise<CPComment[]>;
    saveComment(comment: CPComment): Promise<void>;

    // ── Approvals ─────────────────────────────────────────────────────────

    getApprovals(): Promise<CPApproval[]>;
    getApproval(id: string): Promise<CPApproval | undefined>;
    saveApproval(approval: CPApproval): Promise<void>;

    // ── Runs ──────────────────────────────────────────────────────────────

    getRuns(): Promise<CPRun[]>;
    getRun(id: string): Promise<CPRun | undefined>;
    saveRun(run: CPRun): Promise<void>;
    queryRuns(agentId?: string, limit?: number): Promise<CPRun[]>;

    // ── Activity ──────────────────────────────────────────────────────────

    appendActivity(entry: ActivityEntry): Promise<void>;
    queryActivity(opts: ActivityQueryOpts): Promise<ActivityEntry[]>;

    // ── Budget Reservations (optional — no-op in JSON mode) ──────────────

    saveBudgetReservation?(reservation: BudgetReservation): Promise<void>;
    getBudgetReservation?(id: string): Promise<BudgetReservation | undefined>;

    // ── Transactions (optional — no-op in JSON mode) ──────────────────────

    beginTransaction?(): Promise<Transaction>;
}
