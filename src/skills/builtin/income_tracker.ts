/**
 * TITAN — Income Tracker Skill (Built-in)
 * JSONL-based financial ledger for tracking income and expenses.
 * No external dependencies — pure TypeScript with JSONL persistence.
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { INCOME_LEDGER_PATH } from '../../utils/constants.js';

interface LedgerEntry {
    id: string;
    timestamp: string;
    type: 'income' | 'expense';
    amount: number;
    source: string;
    category: string;
    description: string;
}

interface IncomeGoal {
    month: string; // YYYY-MM
    target: number;
}

const GOALS_PATH = INCOME_LEDGER_PATH.replace('.jsonl', '-goals.json');

function ensureLedgerDir(): void {
    const dir = dirname(INCOME_LEDGER_PATH);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function readLedger(): LedgerEntry[] {
    if (!existsSync(INCOME_LEDGER_PATH)) return [];
    const content = readFileSync(INCOME_LEDGER_PATH, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line) as LedgerEntry);
}

function appendEntry(entry: LedgerEntry): void {
    ensureLedgerDir();
    appendFileSync(INCOME_LEDGER_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

function readGoals(): IncomeGoal[] {
    if (!existsSync(GOALS_PATH)) return [];
    try {
        return JSON.parse(readFileSync(GOALS_PATH, 'utf-8')) as IncomeGoal[];
    } catch {
        return [];
    }
}

function writeGoals(goals: IncomeGoal[]): void {
    ensureLedgerDir();
    writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2), 'utf-8');
}

function formatCurrency(amount: number): string {
    return `$${amount.toFixed(2)}`;
}

export function registerIncomeTrackerSkill(): void {
    // Tool 1: income_log
    registerSkill(
        {
            name: 'income_tracker',
            description: 'Use this skill when Tony says "track this income", "log this payment", "I just got paid X", "log an expense", "how much have I made this month?", "show me my revenue", or "what\'s my net profit?". Manages a local financial ledger for income and expenses.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'income_log',
            description: 'Record a new income or expense entry in the ledger. Use when Tony says "log this income", "I just got paid X from Y", "track this expense", "add a payment from [source]", or "log that I spent X on Y".',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        description: 'Entry type: "income" or "expense"',
                    },
                    amount: {
                        type: 'number',
                        description: 'Dollar amount (positive number)',
                    },
                    source: {
                        type: 'string',
                        description: 'Source of income or expense (e.g., "Upwork", "AWS", "Fiverr")',
                    },
                    category: {
                        type: 'string',
                        description: 'Category (e.g., "freelance", "saas", "hosting", "tools")',
                    },
                    description: {
                        type: 'string',
                        description: 'Description of the transaction',
                    },
                },
                required: ['type', 'amount', 'source'],
            },
            execute: async (args) => {
                try {
                    const type = args.type as 'income' | 'expense';
                    const amount = Math.abs(args.amount as number);
                    const source = args.source as string;
                    const category = (args.category as string) || 'general';
                    const description = (args.description as string) || '';

                    if (type !== 'income' && type !== 'expense') {
                        return 'Error: type must be "income" or "expense"';
                    }

                    const entry: LedgerEntry = {
                        id: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        timestamp: new Date().toISOString(),
                        type,
                        amount,
                        source,
                        category,
                        description,
                    };

                    appendEntry(entry);
                    return `Logged ${type}: ${formatCurrency(amount)} from "${source}" (${category})${description ? ` — ${description}` : ''}`;
                } catch (e) {
                    return `Error logging entry: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: income_summary
    registerSkill(
        {
            name: 'income_tracker',
            description: 'Use this skill when Tony says "track this income", "log this payment", "I just got paid X", "log an expense", "how much have I made this month?", "show me my revenue", or "what\'s my net profit?". Manages a local financial ledger for income and expenses.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'income_summary',
            description: 'Summarize income and expenses by period. Use when Tony asks "how much have I made this month?", "what\'s my revenue this week?", "show me my financials", "what\'s my net profit?", or "break down my income by category".',
            parameters: {
                type: 'object',
                properties: {
                    period: {
                        type: 'string',
                        description: 'Period to summarize: "day", "week", "month", or "all" (default: "month")',
                    },
                    category: {
                        type: 'string',
                        description: 'Filter by category (optional)',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const period = (args.period as string) || 'month';
                    const categoryFilter = args.category as string | undefined;
                    const entries = readLedger();

                    if (entries.length === 0) {
                        return 'No entries in the ledger yet. Use income_log to add entries.';
                    }

                    const now = new Date();
                    let cutoff: Date;

                    switch (period) {
                        case 'day':
                            cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                            break;
                        case 'week':
                            cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                            break;
                        case 'month':
                            cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
                            break;
                        case 'all':
                            cutoff = new Date(0);
                            break;
                        default:
                            cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
                    }

                    let filtered = entries.filter(e => new Date(e.timestamp) >= cutoff);
                    if (categoryFilter) {
                        filtered = filtered.filter(e => e.category.toLowerCase() === categoryFilter.toLowerCase());
                    }

                    const totalIncome = filtered.filter(e => e.type === 'income').reduce((sum, e) => sum + e.amount, 0);
                    const totalExpense = filtered.filter(e => e.type === 'expense').reduce((sum, e) => sum + e.amount, 0);
                    const net = totalIncome - totalExpense;

                    // Group by category
                    const byCategory: Record<string, { income: number; expense: number }> = {};
                    for (const entry of filtered) {
                        if (!byCategory[entry.category]) {
                            byCategory[entry.category] = { income: 0, expense: 0 };
                        }
                        byCategory[entry.category][entry.type] += entry.amount;
                    }

                    // Group by source
                    const bySource: Record<string, number> = {};
                    for (const entry of filtered.filter(e => e.type === 'income')) {
                        bySource[entry.source] = (bySource[entry.source] || 0) + entry.amount;
                    }

                    const lines: string[] = [];
                    lines.push(`Income Summary (${period}):`);
                    lines.push(`  Total Income:  ${formatCurrency(totalIncome)}`);
                    lines.push(`  Total Expense: ${formatCurrency(totalExpense)}`);
                    lines.push(`  Net Profit:    ${formatCurrency(net)}`);
                    lines.push(`  Transactions:  ${filtered.length}`);
                    lines.push('');

                    if (Object.keys(byCategory).length > 0) {
                        lines.push('By Category:');
                        for (const [cat, totals] of Object.entries(byCategory)) {
                            const catNet = totals.income - totals.expense;
                            lines.push(`  ${cat}: +${formatCurrency(totals.income)} / -${formatCurrency(totals.expense)} = ${formatCurrency(catNet)}`);
                        }
                        lines.push('');
                    }

                    if (Object.keys(bySource).length > 0) {
                        lines.push('Top Income Sources:');
                        const sorted = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
                        for (const [source, amount] of sorted.slice(0, 10)) {
                            lines.push(`  ${source}: ${formatCurrency(amount)}`);
                        }
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error generating summary: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: income_list
    registerSkill(
        {
            name: 'income_tracker',
            description: 'Use this skill when Tony says "track this income", "log this payment", "I just got paid X", "log an expense", "how much have I made this month?", "show me my revenue", or "what\'s my net profit?". Manages a local financial ledger for income and expenses.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'income_list',
            description: 'List recent income and expense entries with optional filters. Use when Tony asks "show me recent transactions", "what payments came in from Upwork?", or "list my recent expenses".',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: 'Number of recent entries to show (default: 20)',
                    },
                    type: {
                        type: 'string',
                        description: 'Filter by type: "income" or "expense" (optional)',
                    },
                    source: {
                        type: 'string',
                        description: 'Filter by source (optional)',
                    },
                    category: {
                        type: 'string',
                        description: 'Filter by category (optional)',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const limit = Math.min((args.limit as number) || 20, 100);
                    const typeFilter = args.type as string | undefined;
                    const sourceFilter = args.source as string | undefined;
                    const categoryFilter = args.category as string | undefined;

                    let entries = readLedger();

                    if (entries.length === 0) {
                        return 'No entries in the ledger yet.';
                    }

                    if (typeFilter) {
                        entries = entries.filter(e => e.type === typeFilter);
                    }
                    if (sourceFilter) {
                        entries = entries.filter(e => e.source.toLowerCase().includes(sourceFilter.toLowerCase()));
                    }
                    if (categoryFilter) {
                        entries = entries.filter(e => e.category.toLowerCase() === categoryFilter.toLowerCase());
                    }

                    const recent = entries.slice(-limit).reverse();

                    if (recent.length === 0) {
                        return 'No entries match the given filters.';
                    }

                    const lines = recent.map(e => {
                        const date = new Date(e.timestamp).toLocaleDateString();
                        const sign = e.type === 'income' ? '+' : '-';
                        return `${date} | ${sign}${formatCurrency(e.amount)} | ${e.source} | ${e.category}${e.description ? ` | ${e.description}` : ''}`;
                    });

                    return `Recent entries (${recent.length}):\n${lines.join('\n')}`;
                } catch (e) {
                    return `Error listing entries: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 4: income_goal
    registerSkill(
        {
            name: 'income_tracker',
            description: 'Use this skill when Tony says "track this income", "log this payment", "I just got paid X", "log an expense", "how much have I made this month?", "show me my revenue", or "what\'s my net profit?". Manages a local financial ledger for income and expenses.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'income_goal',
            description: 'Set or check monthly income goals and track progress toward them. Use when Tony says "set my income goal to X this month", "am I on track for my revenue goal?", or "how much more do I need to hit my goal?".',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: '"set" to set a goal, "check" to check progress (default: "check")',
                    },
                    target: {
                        type: 'number',
                        description: 'Monthly income target in dollars (required for "set")',
                    },
                    month: {
                        type: 'string',
                        description: 'Month in YYYY-MM format (default: current month)',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const action = (args.action as string) || 'check';
                    const now = new Date();
                    const month = (args.month as string) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

                    if (action === 'set') {
                        const target = args.target as number;
                        if (!target || target <= 0) {
                            return 'Error: target must be a positive number';
                        }

                        const goals = readGoals();
                        const existing = goals.findIndex(g => g.month === month);
                        if (existing >= 0) {
                            goals[existing].target = target;
                        } else {
                            goals.push({ month, target });
                        }
                        writeGoals(goals);
                        return `Goal set: ${formatCurrency(target)}/month for ${month}`;
                    }

                    // Check progress
                    const goals = readGoals();
                    const goal = goals.find(g => g.month === month);
                    const entries = readLedger();

                    const monthStart = new Date(`${month}-01T00:00:00`);
                    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59);

                    const monthEntries = entries.filter(e => {
                        const d = new Date(e.timestamp);
                        return d >= monthStart && d <= monthEnd;
                    });

                    const income = monthEntries.filter(e => e.type === 'income').reduce((sum, e) => sum + e.amount, 0);
                    const expense = monthEntries.filter(e => e.type === 'expense').reduce((sum, e) => sum + e.amount, 0);
                    const net = income - expense;

                    const lines: string[] = [];
                    lines.push(`Month: ${month}`);
                    lines.push(`Income:  ${formatCurrency(income)}`);
                    lines.push(`Expense: ${formatCurrency(expense)}`);
                    lines.push(`Net:     ${formatCurrency(net)}`);

                    if (goal) {
                        const progress = (income / goal.target) * 100;
                        const remaining = Math.max(0, goal.target - income);
                        lines.push('');
                        lines.push(`Goal:      ${formatCurrency(goal.target)}`);
                        lines.push(`Progress:  ${progress.toFixed(1)}%`);
                        lines.push(`Remaining: ${formatCurrency(remaining)}`);

                        // Days remaining in month
                        const daysInMonth = monthEnd.getDate();
                        const dayOfMonth = now.getDate();
                        const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);
                        if (daysRemaining > 0 && remaining > 0) {
                            const dailyNeeded = remaining / daysRemaining;
                            lines.push(`Daily needed: ${formatCurrency(dailyNeeded)}/day for remaining ${daysRemaining} days`);
                        }
                    } else {
                        lines.push('\nNo goal set for this month. Use income_goal with action="set" to set one.');
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error with goal: ${(e as Error).message}`;
                }
            },
        },
    );
}
