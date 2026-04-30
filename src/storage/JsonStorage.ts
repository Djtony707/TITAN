/**
 * TITAN — JSON File Storage Implementation
 * Implements StorageProvider using the same file paths, in-memory Maps,
 * and read/write patterns extracted from commandPost.ts and goals.ts.
 *
 * Drop-in replacement: commandPost.ts calls getStorage() and uses this interface
 * instead of its module-level Maps and bare fs calls.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { atomicWriteJsonFile } from '../utils/helpers.js';
import { join } from 'path';
import { TITAN_HOME, TELEMETRY_EVENTS_PATH } from '../utils/constants.js';
import { mkdirIfNotExists } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import type {
    StorageProvider,
    IssueFilters,
    ActivityQueryOpts,
    BudgetReservation,
    Transaction,
    TelemetryEvent,
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

const COMPONENT = 'JsonStorage';

// ─── Disk Paths (mirrors commandPost.ts / goals.ts) ───────────────────────

const GOALS_PATH     = join(TITAN_HOME, 'goals.json');
const STATE_PATH     = join(TITAN_HOME, 'command-post.json');
const ACTIVITY_PATH  = join(TITAN_HOME, 'command-post-activity.jsonl');

// ─── On-disk Shapes ───────────────────────────────────────────────────────

interface GoalsStore {
    goals: Goal[];
    lastUpdated: string;
}

interface CommandPostState {
    checkouts: TaskCheckout[];
    budgetPolicies: BudgetPolicy[];
    agents: RegisteredAgent[];
    issues: CPIssue[];
    approvals: CPApproval[];
    runs: CPRun[];
    comments: CPComment[];
    issueCounter: number;
    lastSaved: string;
}

// ─── JsonStorage Class ────────────────────────────────────────────────────

export class JsonStorage implements StorageProvider {

    // ── In-memory caches ────────────────────────────────────────────────

    private goalsCache: Goal[] | null = null;

    private checkouts     = new Map<string, TaskCheckout>();
    private budgetPolicies: BudgetPolicy[] = [];
    private agents        = new Map<string, RegisteredAgent>();
    private issues        = new Map<string, CPIssue>();
    private approvals     = new Map<string, CPApproval>();
    private runs: CPRun[] = [];
    private comments: CPComment[] = [];
    private activityBuffer: ActivityEntry[] = [];
    private issueCounter = 0;

    private stateLoaded = false;
    private goalsLoaded = false;

    // ── Lifecycle ────────────────────────────────────────────────────────

    async init(): Promise<void> {
        mkdirIfNotExists(TITAN_HOME);
        this.loadGoals();
        this.loadState();
        logger.info(COMPONENT, 'JSON storage initialized');
    }

    async shutdown(): Promise<void> {
        this.saveGoals();
        this.saveState();
        logger.info(COMPONENT, 'JSON storage shut down');
    }

    // ── Internal: Goals persistence ───────────────────────────────────

    private loadGoals(): void {
        if (this.goalsLoaded) return;
        this.goalsLoaded = true;

        if (!existsSync(GOALS_PATH)) {
            this.goalsCache = [];
            return;
        }
        try {
            const raw = readFileSync(GOALS_PATH, 'utf-8');
            const store = JSON.parse(raw) as GoalsStore;
            this.goalsCache = store.goals || [];
        } catch (err) {
            logger.warn(COMPONENT, `Failed to load goals: ${(err as Error).message}`);
            this.goalsCache = [];
        }
    }

    private saveGoals(): void {
        const goals = this.goalsCache || [];
        try {
            mkdirIfNotExists(TITAN_HOME);
            const store: GoalsStore = {
                goals,
                lastUpdated: new Date().toISOString(),
            };
            atomicWriteJsonFile(GOALS_PATH, store);
        } catch (err) {
            logger.error(COMPONENT, `Failed to save goals: ${(err as Error).message}`);
        }
    }

    // ── Internal: Command Post persistence ───────────────────────────

    private loadState(): void {
        if (this.stateLoaded) return;
        this.stateLoaded = true;

        if (!existsSync(STATE_PATH)) return;
        try {
            const raw = readFileSync(STATE_PATH, 'utf-8');
            const state = JSON.parse(raw) as CommandPostState;

            for (const c of state.checkouts || []) {
                if (c.status === 'locked') this.checkouts.set(c.subtaskId, c);
            }
            this.budgetPolicies = state.budgetPolicies || [];
            for (const a of state.agents || []) {
                if (!a.role) a.role = 'general'; // backcompat
                this.agents.set(a.id, a);
            }
            for (const i of state.issues || []) this.issues.set(i.id, i);
            for (const ap of state.approvals || []) this.approvals.set(ap.id, ap);
            this.runs.push(...(state.runs || []).slice(-200)); // keep last 200
            this.comments.push(...(state.comments || []));
            this.issueCounter = state.issueCounter || (state.issues?.length || 0);
        } catch (err) {
            logger.warn(COMPONENT, `Failed to load state: ${(err as Error).message}`);
        }
    }

    private saveState(): void {
        try {
            mkdirIfNotExists(TITAN_HOME);
            const state: CommandPostState = {
                checkouts: Array.from(this.checkouts.values()),
                budgetPolicies: this.budgetPolicies,
                agents: Array.from(this.agents.values()),
                issues: Array.from(this.issues.values()),
                approvals: Array.from(this.approvals.values()),
                runs: this.runs.slice(-200),
                comments: this.comments,
                issueCounter: this.issueCounter,
                lastSaved: new Date().toISOString(),
            };
            atomicWriteJsonFile(STATE_PATH, state);
        } catch (err) {
            logger.error(COMPONENT, `Failed to save state: ${(err as Error).message}`);
        }
    }

    // ── Goals ────────────────────────────────────────────────────────────

    async getGoals(): Promise<Goal[]> {
        this.loadGoals();
        return [...(this.goalsCache || [])];
    }

    async getGoal(id: string): Promise<Goal | undefined> {
        this.loadGoals();
        return this.goalsCache?.find(g => g.id === id);
    }

    async saveGoal(goal: Goal): Promise<void> {
        this.loadGoals();
        const goals = this.goalsCache!;
        const idx = goals.findIndex(g => g.id === goal.id);
        if (idx === -1) {
            goals.push(goal);
        } else {
            goals[idx] = goal;
        }
        this.saveGoals();
    }

    async deleteGoal(id: string): Promise<boolean> {
        this.loadGoals();
        const goals = this.goalsCache!;
        const idx = goals.findIndex(g => g.id === id);
        if (idx === -1) return false;
        goals.splice(idx, 1);
        this.saveGoals();
        return true;
    }

    async saveSubtask(goalId: string, subtask: Subtask): Promise<void> {
        // Subtasks are stored inline on the parent Goal in JSON mode.
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

    // ── Agents ───────────────────────────────────────────────────────────

    async getAgents(): Promise<RegisteredAgent[]> {
        this.loadState();
        return Array.from(this.agents.values());
    }

    async getAgent(id: string): Promise<RegisteredAgent | undefined> {
        this.loadState();
        return this.agents.get(id);
    }

    async saveAgent(agent: RegisteredAgent): Promise<void> {
        this.loadState();
        this.agents.set(agent.id, agent);
        this.saveState();
    }

    async deleteAgent(id: string): Promise<boolean> {
        this.loadState();
        const existed = this.agents.has(id);
        this.agents.delete(id);
        if (existed) this.saveState();
        return existed;
    }

    // ── Task Checkouts ────────────────────────────────────────────────────

    async getCheckouts(): Promise<TaskCheckout[]> {
        this.loadState();
        return Array.from(this.checkouts.values());
    }

    async getCheckout(subtaskId: string): Promise<TaskCheckout | undefined> {
        this.loadState();
        return this.checkouts.get(subtaskId);
    }

    async saveCheckout(checkout: TaskCheckout): Promise<void> {
        this.loadState();
        this.checkouts.set(checkout.subtaskId, checkout);
        this.saveState();
    }

    async deleteCheckout(subtaskId: string): Promise<void> {
        this.loadState();
        this.checkouts.delete(subtaskId);
        this.saveState();
    }

    // ── Budget Policies ───────────────────────────────────────────────────

    async getBudgetPolicies(): Promise<BudgetPolicy[]> {
        this.loadState();
        return [...this.budgetPolicies];
    }

    async getBudgetPolicy(id: string): Promise<BudgetPolicy | undefined> {
        this.loadState();
        return this.budgetPolicies.find(p => p.id === id);
    }

    async saveBudgetPolicy(policy: BudgetPolicy): Promise<void> {
        this.loadState();
        const idx = this.budgetPolicies.findIndex(p => p.id === policy.id);
        if (idx === -1) {
            this.budgetPolicies.push(policy);
        } else {
            this.budgetPolicies[idx] = policy;
        }
        this.saveState();
    }

    async deleteBudgetPolicy(id: string): Promise<boolean> {
        this.loadState();
        const idx = this.budgetPolicies.findIndex(p => p.id === id);
        if (idx === -1) return false;
        this.budgetPolicies.splice(idx, 1);
        this.saveState();
        return true;
    }

    // ── Issues ────────────────────────────────────────────────────────────

    async getIssues(): Promise<CPIssue[]> {
        this.loadState();
        return Array.from(this.issues.values());
    }

    async getIssue(id: string): Promise<CPIssue | undefined> {
        this.loadState();
        return this.issues.get(id);
    }

    async saveIssue(issue: CPIssue): Promise<void> {
        this.loadState();
        this.issues.set(issue.id, issue);
        this.saveState();
    }

    async deleteIssue(id: string): Promise<boolean> {
        this.loadState();
        const existed = this.issues.has(id);
        this.issues.delete(id);
        if (existed) this.saveState();
        return existed;
    }

    async queryIssues(filters: IssueFilters): Promise<CPIssue[]> {
        this.loadState();
        let result = Array.from(this.issues.values());
        if (filters.status) result = result.filter(i => i.status === filters.status);
        if (filters.assigneeAgentId) result = result.filter(i => i.assigneeAgentId === filters.assigneeAgentId);
        if (filters.goalId) result = result.filter(i => i.goalId === filters.goalId);
        return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    // ── Issue Counter ─────────────────────────────────────────────────────

    async getIssueCounter(): Promise<number> {
        this.loadState();
        return this.issueCounter;
    }

    async incrementIssueCounter(): Promise<number> {
        this.loadState();
        this.issueCounter++;
        this.saveState();
        return this.issueCounter;
    }

    // ── Comments ──────────────────────────────────────────────────────────

    async getComments(issueId: string): Promise<CPComment[]> {
        this.loadState();
        return this.comments.filter(c => c.issueId === issueId);
    }

    async saveComment(comment: CPComment): Promise<void> {
        this.loadState();
        this.comments.push(comment);
        this.saveState();
    }

    // ── Approvals ─────────────────────────────────────────────────────────

    async getApprovals(): Promise<CPApproval[]> {
        this.loadState();
        return Array.from(this.approvals.values());
    }

    async getApproval(id: string): Promise<CPApproval | undefined> {
        this.loadState();
        return this.approvals.get(id);
    }

    async saveApproval(approval: CPApproval): Promise<void> {
        this.loadState();
        this.approvals.set(approval.id, approval);
        this.saveState();
    }

    // ── Runs ──────────────────────────────────────────────────────────────

    async getRuns(): Promise<CPRun[]> {
        this.loadState();
        return [...this.runs];
    }

    async getRun(id: string): Promise<CPRun | undefined> {
        this.loadState();
        return this.runs.find(r => r.id === id);
    }

    async saveRun(run: CPRun): Promise<void> {
        this.loadState();
        const idx = this.runs.findIndex(r => r.id === run.id);
        if (idx === -1) {
            this.runs.push(run);
            // Mirror the hard cap from commandPost.ts
            if (this.runs.length > 500) this.runs.splice(0, this.runs.length - 500);
        } else {
            this.runs[idx] = run;
        }
        this.saveState();
    }

    async queryRuns(agentId?: string, limit = 50): Promise<CPRun[]> {
        this.loadState();
        let result = [...this.runs];
        if (agentId) result = result.filter(r => r.agentId === agentId);
        return result.slice(-limit).reverse();
    }

    // ── Activity ──────────────────────────────────────────────────────────

    async appendActivity(entry: ActivityEntry): Promise<void> {
        // In-memory buffer (non-blocking; size managed by CommandPost)
        this.activityBuffer.push(entry);
        // JSONL append — non-critical, same as commandPost.ts original
        try {
            appendFileSync(ACTIVITY_PATH, JSON.stringify(entry) + '\n', 'utf-8');
        } catch { /* non-critical */ }
    }

    async queryActivity(opts: ActivityQueryOpts): Promise<ActivityEntry[]> {
        let entries = [...this.activityBuffer];
        if (opts.type) entries = entries.filter(e => e.type === opts.type);
        if (opts.limit) entries = entries.slice(-opts.limit);
        return entries;
    }

    /** Expose internal buffer so CommandPost can manage its own size cap */
    getActivityBuffer(): ActivityEntry[] {
        return this.activityBuffer;
    }

    // ── Budget Reservations (no-op in JSON mode) ──────────────────────────

    async saveBudgetReservation(_reservation: BudgetReservation): Promise<void> {
        // JSON mode: reservations are not persisted separately.
        // Budget spend is tracked directly on BudgetPolicy.currentSpend.
    }

    async getBudgetReservation(_id: string): Promise<BudgetReservation | undefined> {
        return undefined;
    }

    // ── Transactions (no-op — event-loop guarantee is sufficient in JSON mode) ─

    async beginTransaction(): Promise<Transaction> {
        return {
            async commit() { /* no-op */ },
            async rollback() { /* no-op */ },
        };
    }

    // ── Telemetry ─────────────────────────────────────────────────────────

    async appendTelemetryEvent(entry: TelemetryEvent): Promise<void> {
        try {
            appendFileSync(TELEMETRY_EVENTS_PATH, JSON.stringify(entry) + '\n', 'utf-8');
        } catch { /* non-critical */ }
    }

    async queryTelemetryEvents(opts: { limit?: number }): Promise<TelemetryEvent[]> {
        const limit = opts.limit ?? 100;
        try {
            if (!existsSync(TELEMETRY_EVENTS_PATH)) return [];
            const raw = readFileSync(TELEMETRY_EVENTS_PATH, 'utf-8');
            const lines = raw.trim().split('\n').filter(Boolean);
            const events = lines
                .slice(-limit)
                .map((line) => {
                    try { return JSON.parse(line) as TelemetryEvent; } catch { return null; }
                })
                .filter((e): e is TelemetryEvent => e !== null);
            return events;
        } catch {
            return [];
        }
    }
}
