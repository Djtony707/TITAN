/**
 * TITAN — Company Manager
 *
 * Paperclip AI-inspired company system. Companies are autonomous organizational
 * containers with their own agents, goals, budgets, and activity feeds.
 *
 * Create a company → assign agents → set goals → let it run autonomously.
 * Delete a company → all agents stop, goals archive, budgets release.
 *
 * Storage: ~/.titan/companies.json
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { TITAN_HOME } from '../utils/constants.js';
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Company';
const COMPANIES_FILE = join(TITAN_HOME, 'companies.json');

// ── Types ───────────────────────────────────────────────────────

export interface Company {
    id: string;
    name: string;
    description: string;
    mission?: string;
    status: 'active' | 'paused' | 'archived';
    agents: CompanyAgent[];
    goals: CompanyGoal[];
    budget?: {
        limitUsd: number;
        spentUsd: number;
        period: 'daily' | 'weekly' | 'monthly';
    };
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    metadata?: Record<string, unknown>;
}

export interface CompanyAgent {
    id: string;
    name: string;
    role: string;
    template: string;  // 'explorer' | 'coder' | 'analyst' | 'browser'
    status: 'active' | 'idle' | 'stopped';
}

export interface CompanyGoal {
    id: string;
    title: string;
    description?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    assignedAgent?: string;
    createdAt: string;
    completedAt?: string;
}

// ── Storage ─────────────────────────────────────────────────────

function loadCompanies(): Company[] {
    try {
        if (existsSync(COMPANIES_FILE)) {
            return JSON.parse(readFileSync(COMPANIES_FILE, 'utf-8'));
        }
    } catch { /* corrupted — start fresh */ }
    return [];
}

function saveCompanies(companies: Company[]): void {
    writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));
}

// ── CRUD ────────────────────────────────────────────────────────

/** Create a new company */
export function createCompany(params: {
    name: string;
    description: string;
    mission?: string;
    agents?: Array<{ name: string; role: string; template: string }>;
    goals?: Array<{ title: string; description?: string }>;
    budget?: { limitUsd: number; period: 'daily' | 'weekly' | 'monthly' };
    createdBy?: string;
}): Company {
    const companies = loadCompanies();

    // Check for duplicate name
    if (companies.some(c => c.name.toLowerCase() === params.name.toLowerCase() && c.status !== 'archived')) {
        throw new Error(`Company "${params.name}" already exists`);
    }

    const company: Company = {
        id: uuid(),
        name: params.name,
        description: params.description,
        mission: params.mission,
        status: 'active',
        agents: (params.agents || []).map(a => ({
            id: uuid(),
            name: a.name,
            role: a.role,
            template: a.template,
            status: 'idle' as const,
        })),
        goals: (params.goals || []).map(g => ({
            id: uuid(),
            title: g.title,
            description: g.description,
            status: 'pending' as const,
            createdAt: new Date().toISOString(),
        })),
        budget: params.budget ? { ...params.budget, spentUsd: 0 } : undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: params.createdBy || 'system',
    };

    companies.push(company);
    saveCompanies(companies);

    titanEvents.emit('company:created', { id: company.id, name: company.name });
    logger.info(COMPONENT, `Created company: ${company.name} (${company.id}) with ${company.agents.length} agents, ${company.goals.length} goals`);

    return company;
}

/** List all companies */
export function listCompanies(includeArchived = false): Company[] {
    const companies = loadCompanies();
    return includeArchived ? companies : companies.filter(c => c.status !== 'archived');
}

/** Get a company by ID */
export function getCompany(id: string): Company | null {
    return loadCompanies().find(c => c.id === id) || null;
}

/** Update a company */
export function updateCompany(id: string, updates: Partial<Pick<Company, 'name' | 'description' | 'mission' | 'status' | 'metadata'>>): Company | null {
    const companies = loadCompanies();
    const idx = companies.findIndex(c => c.id === id);
    if (idx < 0) return null;

    Object.assign(companies[idx], updates, { updatedAt: new Date().toISOString() });
    saveCompanies(companies);

    logger.info(COMPONENT, `Updated company: ${companies[idx].name}`);
    return companies[idx];
}

/** Delete (archive) a company */
export function deleteCompany(id: string): boolean {
    const companies = loadCompanies();
    const idx = companies.findIndex(c => c.id === id);
    if (idx < 0) return false;

    const company = companies[idx];
    company.status = 'archived';
    company.updatedAt = new Date().toISOString();

    // Stop all agents
    for (const agent of company.agents) {
        agent.status = 'stopped';
    }

    saveCompanies(companies);

    titanEvents.emit('company:deleted', { id: company.id, name: company.name });
    logger.info(COMPONENT, `Archived company: ${company.name} (${company.agents.length} agents stopped)`);

    return true;
}

/** Permanently remove archived companies */
export function purgeArchivedCompanies(): number {
    const companies = loadCompanies();
    const before = companies.length;
    const active = companies.filter(c => c.status !== 'archived');
    saveCompanies(active);
    const purged = before - active.length;
    if (purged > 0) logger.info(COMPONENT, `Purged ${purged} archived companies`);
    return purged;
}

// ── Agent Management ────────────────────────────────────────────

/** Add an agent to a company */
export function addAgentToCompany(companyId: string, agent: { name: string; role: string; template: string }): CompanyAgent | null {
    const companies = loadCompanies();
    const company = companies.find(c => c.id === companyId);
    if (!company) return null;

    const newAgent: CompanyAgent = {
        id: uuid(),
        name: agent.name,
        role: agent.role,
        template: agent.template,
        status: 'idle',
    };

    company.agents.push(newAgent);
    company.updatedAt = new Date().toISOString();
    saveCompanies(companies);

    return newAgent;
}

/** Remove an agent from a company */
export function removeAgentFromCompany(companyId: string, agentId: string): boolean {
    const companies = loadCompanies();
    const company = companies.find(c => c.id === companyId);
    if (!company) return false;

    company.agents = company.agents.filter(a => a.id !== agentId);
    company.updatedAt = new Date().toISOString();
    saveCompanies(companies);

    return true;
}

// ── Goal Management ─────────────────────────────────────────────

/** Add a goal to a company */
export function addGoalToCompany(companyId: string, goal: { title: string; description?: string }): CompanyGoal | null {
    const companies = loadCompanies();
    const company = companies.find(c => c.id === companyId);
    if (!company) return null;

    const newGoal: CompanyGoal = {
        id: uuid(),
        title: goal.title,
        description: goal.description,
        status: 'pending',
        createdAt: new Date().toISOString(),
    };

    company.goals.push(newGoal);
    company.updatedAt = new Date().toISOString();
    saveCompanies(companies);

    return newGoal;
}

// ── Heartbeat Runner ────────────────────────────────────────────
// Paperclip-style continuous execution: company runs on a heartbeat,
// checking goals, dispatching agents, and reporting progress.

const activeRunners: Map<string, NodeJS.Timeout> = new Map();

/** Start a company's heartbeat — agents check tasks and work autonomously */
export function startCompanyRunner(companyId: string, intervalMs = 60000): boolean {
    if (activeRunners.has(companyId)) return false; // Already running

    const company = getCompany(companyId);
    if (!company || company.status !== 'active') return false;

    logger.info(COMPONENT, `Starting heartbeat for "${company.name}" (every ${intervalMs / 1000}s)`);

    const tick = async () => {
        const current = getCompany(companyId);
        if (!current || current.status !== 'active') {
            stopCompanyRunner(companyId);
            return;
        }

        const pendingGoals = current.goals.filter(g => g.status === 'pending' || g.status === 'in_progress');
        if (pendingGoals.length === 0) {
            logger.info(COMPONENT, `[${current.name}] No pending goals — heartbeat idle`);
            titanEvents.emit('company:heartbeat', { id: companyId, name: current.name, status: 'idle', pendingGoals: 0 });
            return;
        }

        titanEvents.emit('company:heartbeat', { id: companyId, name: current.name, status: 'working', pendingGoals: pendingGoals.length });

        // Pick the first pending goal and dispatch to an idle agent
        const goal = pendingGoals.find(g => g.status === 'pending') || pendingGoals[0];
        const idleAgent = current.agents.find(a => a.status === 'idle');

        if (goal && idleAgent) {
            logger.info(COMPONENT, `[${current.name}] Dispatching "${idleAgent.name}" on goal: ${goal.title}`);
            goal.status = 'in_progress';
            goal.assignedAgent = idleAgent.id;
            idleAgent.status = 'active';

            const companies = loadCompanies();
            const idx = companies.findIndex(c => c.id === companyId);
            if (idx >= 0) {
                companies[idx] = current;
                saveCompanies(companies);
            }

            // Actually run the task via processMessage
            try {
                const { processMessage } = await import('./agent.js');
                const result = await processMessage(
                    `[Company: ${current.name}] Goal: ${goal.title}${goal.description ? `\n\nDetails: ${goal.description}` : ''}`,
                    'company',
                    `company-${companyId}`,
                );

                // Update goal status based on result
                const success = !result.content.toLowerCase().includes('error') && !result.exhaustedBudget;
                updateGoalStatus(companyId, goal.id, success ? 'completed' : 'failed');

                // Reset agent to idle
                const updated = getCompany(companyId);
                if (updated) {
                    const agent = updated.agents.find(a => a.id === idleAgent.id);
                    if (agent) agent.status = 'idle';
                    const companies2 = loadCompanies();
                    const idx2 = companies2.findIndex(c => c.id === companyId);
                    if (idx2 >= 0) { companies2[idx2] = updated; saveCompanies(companies2); }
                }

                titanEvents.emit('company:goal:completed', { companyId, goalId: goal.id, success, agentName: idleAgent.name });
                logger.info(COMPONENT, `[${current.name}] Goal "${goal.title}" ${success ? 'completed' : 'failed'} by ${idleAgent.name}`);
            } catch (e) {
                updateGoalStatus(companyId, goal.id, 'failed');
                logger.error(COMPONENT, `[${current.name}] Goal execution error: ${(e as Error).message}`);
            }
        }
    };

    // First tick immediately, then on interval
    tick().catch(() => {});
    const timer = setInterval(() => tick().catch(() => {}), intervalMs);
    activeRunners.set(companyId, timer);

    const companies = loadCompanies();
    const idx = companies.findIndex(c => c.id === companyId);
    if (idx >= 0) {
        (companies[idx] as Record<string, unknown>).runnerActive = true;
        saveCompanies(companies);
    }

    return true;
}

/** Stop a company's heartbeat */
export function stopCompanyRunner(companyId: string): boolean {
    const timer = activeRunners.get(companyId);
    if (!timer) return false;

    clearInterval(timer);
    activeRunners.delete(companyId);

    const companies = loadCompanies();
    const idx = companies.findIndex(c => c.id === companyId);
    if (idx >= 0) {
        (companies[idx] as Record<string, unknown>).runnerActive = false;
        saveCompanies(companies);
    }

    const company = getCompany(companyId);
    logger.info(COMPONENT, `Stopped heartbeat for "${company?.name || companyId}"`);
    return true;
}

/** Check if a company's runner is active */
export function isRunnerActive(companyId: string): boolean {
    return activeRunners.has(companyId);
}

/** Get all active runners */
export function getActiveRunners(): string[] {
    return [...activeRunners.keys()];
}

/** Update a goal's status */
export function updateGoalStatus(companyId: string, goalId: string, status: CompanyGoal['status']): boolean {
    const companies = loadCompanies();
    const company = companies.find(c => c.id === companyId);
    if (!company) return false;

    const goal = company.goals.find(g => g.id === goalId);
    if (!goal) return false;

    goal.status = status;
    if (status === 'completed' || status === 'failed') {
        goal.completedAt = new Date().toISOString();
    }
    company.updatedAt = new Date().toISOString();
    saveCompanies(companies);

    return true;
}
