/**
 * TITAN — Company Markdown Portability
 *
 * PaperclipAI-inspired: export entire companies as version-controllable
 * markdown packages. A company becomes a portable, human-readable artifact
 * that can be git-tracked, shared, and imported into any TITAN instance.
 *
 * Export structure:
 *   COMPANY.md          — Company manifest (name, mission, budget, metadata)
 *   agents/AGENTS.md    — Agent roster with roles and templates
 *   goals/GOALS.md      — Goal backlog with status and assignments
 *   .titan-company.yaml — Machine-readable manifest for import
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import type { Company, CompanyAgent, CompanyGoal } from './company.js';

const COMPONENT = 'CompanyPortability';

// ─── Export ──────────────────────────────────────────────────────

export interface CompanyPackage {
    manifest: CompanyManifest;
    markdown: string;      // Combined markdown for single-file export
    files: Record<string, string>; // filename -> content
}

export interface CompanyManifest {
    version: 'titan-company/v1';
    id: string;
    name: string;
    exportedAt: string;
    files: string[];
}

/** Export a company to a markdown package */
export function exportCompanyToPackage(company: Company): CompanyPackage {
    const files: Record<string, string> = {};

    // COMPANY.md — Human-readable manifest
    files['COMPANY.md'] = renderCompanyMd(company);

    // agents/AGENTS.md — Agent roster
    if (company.agents.length > 0) {
        files['agents/AGENTS.md'] = renderAgentsMd(company.agents);
    }

    // goals/GOALS.md — Goal backlog
    if (company.goals.length > 0) {
        files['goals/GOALS.md'] = renderGoalsMd(company.goals);
    }

    // .titan-company.yaml — Machine-readable manifest
    const manifest: CompanyManifest = {
        version: 'titan-company/v1',
        id: company.id,
        name: company.name,
        exportedAt: new Date().toISOString(),
        files: Object.keys(files),
    };
    files['.titan-company.yaml'] = renderManifestYaml(manifest);

    // Combined single-file markdown (for copy-paste / gist sharing)
    const markdown = renderCombinedMarkdown(company, manifest);

    return { manifest, markdown, files };
}

/** Write a company package to disk */
export function writeCompanyPackage(company: Company, outDir?: string): string {
    const pkg = exportCompanyToPackage(company);
    const dir = outDir || join(TITAN_HOME, 'exports', `company-${company.id}`);

    mkdirSync(dir, { recursive: true });

    for (const [relativePath, content] of Object.entries(pkg.files)) {
        const filePath = join(dir, relativePath);
        const parentDir = filePath.slice(0, filePath.lastIndexOf('/'));
        if (parentDir && parentDir !== dir) {
            mkdirSync(parentDir, { recursive: true });
        }
        writeFileSync(filePath, content, 'utf-8');
    }

    // Also write combined markdown
    writeFileSync(join(dir, `${company.name.replace(/\s+/g, '-').toLowerCase()}.md`), pkg.markdown, 'utf-8');

    logger.info(COMPONENT, `Exported company "${company.name}" to ${dir}`);
    return dir;
}

// ─── Import ──────────────────────────────────────────────────────

export interface ImportedCompany {
    name: string;
    description: string;
    mission?: string;
    agents: Array<{ name: string; role: string; template: string }>;
    goals: Array<{ title: string; description?: string }>;
    budget?: { limitUsd: number; period: 'daily' | 'weekly' | 'monthly' };
}

/** Import a company from a markdown package directory */
export function importCompanyFromDirectory(dir: string): ImportedCompany | null {
    try {
        // Try manifest-first import
        const manifestPath = join(dir, '.titan-company.yaml');
        if (existsSync(manifestPath)) {
            return importFromManifest(dir, readFileSync(manifestPath, 'utf-8'));
        }

        // Fallback: parse COMPANY.md directly
        const companyMdPath = join(dir, 'COMPANY.md');
        if (existsSync(companyMdPath)) {
            return parseCompanyMarkdown(readFileSync(companyMdPath, 'utf-8'));
        }

        return null;
    } catch (e) {
        logger.error(COMPONENT, `Import failed: ${(e as Error).message}`);
        return null;
    }
}

/** Import from a combined single-file markdown string */
export function importCompanyFromMarkdown(markdown: string): ImportedCompany | null {
    return parseCompanyMarkdown(markdown);
}

// ─── Renderers ───────────────────────────────────────────────────

function renderCompanyMd(c: Company): string {
    const budgetLine = c.budget
        ? `| Budget | $${c.budget.limitUsd} / ${c.budget.period} (spent: $${c.budget.spentUsd.toFixed(2)}) |`
        : '| Budget | None |';

    return `# ${c.name}

> ${c.description}

## Overview

| Field | Value |
|-------|-------|
| Status | ${c.status} |
| Mission | ${c.mission || '—'} |
| Agents | ${c.agents.length} |
| Goals | ${c.goals.length} |
${budgetLine}
| Created | ${c.createdAt} |
| Updated | ${c.updatedAt} |

## Quick Start

This company can be imported into any TITAN instance:

\`\`\`bash
# Via CLI
titan company import ./${c.name.replace(/\s+/g, '-').toLowerCase()}

# Via API
POST /api/companies/import
body: { packagePath: "./${c.name.replace(/\s+/g, '-').toLowerCase()}" }
\`\`\`

---

*Exported from TITAN on ${new Date().toISOString()}*
`;
}

function renderAgentsMd(agents: CompanyAgent[]): string {
    const rows = agents.map(a =>
        `| ${a.name} | ${a.role} | ${a.template} | ${a.status} |`
    ).join('\n');

    return `# Agent Roster

| Name | Role | Template | Status |
|------|------|----------|--------|
${rows}

## Templates

- **explorer** — Research and discovery specialist
- **coder** — Software development and debugging
- **analyst** — Data analysis and reporting
- **browser** — Web automation and scraping
`;
}

function renderGoalsMd(goals: CompanyGoal[]): string {
    const pending = goals.filter(g => g.status === 'pending');
    const inProgress = goals.filter(g => g.status === 'in_progress');
    const completed = goals.filter(g => g.status === 'completed');
    const failed = goals.filter(g => g.status === 'failed');

    const renderSection = (title: string, items: CompanyGoal[]) => {
        if (items.length === 0) return '';
        const rows = items.map(g =>
            `| ${g.title} | ${g.description || '—'} | ${g.assignedAgent || 'Unassigned'} |`
        ).join('\n');
        return `### ${title}\n\n| Goal | Description | Assigned |\n|------|-------------|----------|\n${rows}\n\n`;
    };

    return `# Goals Backlog

${renderSection('In Progress', inProgress)}
${renderSection('Pending', pending)}
${renderSection('Completed', completed)}
${renderSection('Failed', failed)}
`;
}

function renderManifestYaml(m: CompanyManifest): string {
    return `# TITAN Company Manifest
# Machine-readable import metadata. Do not edit by hand.
version: ${m.version}
id: ${m.id}
name: ${m.name}
exportedAt: "${m.exportedAt}"
files:\n${m.files.map(f => `  - ${f}`).join('\n')}
`;
}

function renderCombinedMarkdown(c: Company, m: CompanyManifest): string {
    return `# ${c.name}

<!-- titan-company-manifest-start
${JSON.stringify(m, null, 2)}
titan-company-manifest-end -->

${renderCompanyMd(c)}

---

${c.agents.length > 0 ? renderAgentsMd(c.agents) : ''}

---

${c.goals.length > 0 ? renderGoalsMd(c.goals) : ''}
`;
}

// ─── Parsers ─────────────────────────────────────────────────────

function importFromManifest(dir: string, yamlContent: string): ImportedCompany | null {
    // Simple YAML parsing (no dependency)
    const name = extractYamlValue(yamlContent, 'name');
    if (!name) return null;

    const company: ImportedCompany = {
        name,
        description: '',
        agents: [],
        goals: [],
    };

    // Parse agents
    const agentsPath = join(dir, 'agents/AGENTS.md');
    if (existsSync(agentsPath)) {
        company.agents = parseAgentsTable(readFileSync(agentsPath, 'utf-8'));
    }

    // Parse goals
    const goalsPath = join(dir, 'goals/GOALS.md');
    if (existsSync(goalsPath)) {
        company.goals = parseGoalsTable(readFileSync(goalsPath, 'utf-8'));
    }

    // Parse company metadata
    const companyPath = join(dir, 'COMPANY.md');
    if (existsSync(companyPath)) {
        const md = readFileSync(companyPath, 'utf-8');
        company.description = extractMdField(md, 'description') || extractMdField(md, 'Description') || '';
        company.mission = extractMdField(md, 'mission') || extractMdField(md, 'Mission') || undefined;

        const budgetLimit = extractMdField(md, 'budget') || extractMdField(md, 'Budget');
        if (budgetLimit) {
            const match = budgetLimit.match(/\$([\d.]+)\s*\/\s*(daily|weekly|monthly)/i);
            if (match) {
                company.budget = {
                    limitUsd: parseFloat(match[1]),
                    period: match[2].toLowerCase() as 'daily' | 'weekly' | 'monthly',
                };
            }
        }
    }

    return company;
}

function parseCompanyMarkdown(markdown: string): ImportedCompany | null {
    // Try to extract embedded manifest
    const manifestMatch = markdown.match(/<!-- titan-company-manifest-start\n([\s\S]*?)\ntitan-company-manifest-end -->/);
    if (manifestMatch) {
        try {
            const manifest = JSON.parse(manifestMatch[1]) as CompanyManifest;
            // Reconstruct from the markdown sections
            const company: ImportedCompany = {
                name: manifest.name,
                description: extractMdSection(markdown, 'Overview') || '',
                agents: parseAgentsTable(markdown),
                goals: parseGoalsTable(markdown),
            };
            return company;
        } catch { /* fallback */ }
    }

    // Direct parse
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    if (!titleMatch) return null;

    return {
        name: titleMatch[1].trim(),
        description: extractMdSection(markdown, 'Overview') || '',
        agents: parseAgentsTable(markdown),
        goals: parseGoalsTable(markdown),
    };
}

function parseAgentsTable(markdown: string): Array<{ name: string; role: string; template: string }> {
    const agents: Array<{ name: string; role: string; template: string }> = [];
    const tableMatch = markdown.match(/#+\s+Agent Roster[\s\S]*?(\|[-\s|]+\|[\s\S]*?)(?=\n#+\s|\n---|$)/);
    if (!tableMatch) return agents;

    const lines = tableMatch[1].split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
    for (const line of lines) {
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 3 && cols[0] !== 'Name') {
            agents.push({ name: cols[0], role: cols[1], template: cols[2] });
        }
    }
    return agents;
}

function parseGoalsTable(markdown: string): Array<{ title: string; description?: string }> {
    const goals: Array<{ title: string; description?: string }> = [];
    const tableMatch = markdown.match(/#+\s+Goals Backlog[\s\S]*?(\|[-\s|]+\|[\s\S]*?)(?=\n#+\s|\n---|$)/);
    if (!tableMatch) return goals;

    const lines = tableMatch[1].split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
    for (const line of lines) {
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 2 && cols[0] !== 'Goal') {
            goals.push({ title: cols[0], description: cols[1] !== '—' ? cols[1] : undefined });
        }
    }
    return goals;
}

function extractMdField(markdown: string, fieldName: string): string | undefined {
    const regex = new RegExp(`\\|\\s*${fieldName}\\s*\\|\\s*([^|]+)\\s*\\|`, 'i');
    const match = markdown.match(regex);
    return match ? match[1].trim() : undefined;
}

function extractMdSection(markdown: string, sectionName: string): string | undefined {
    const regex = new RegExp(`#+\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n#+\\s|\\n---|$)`);
    const match = markdown.match(regex);
    return match ? match[1].trim() : undefined;
}

function extractYamlValue(yaml: string, key: string): string | undefined {
    const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const match = yaml.match(regex);
    return match ? match[1].trim().replace(/^"|"$/g, '') : undefined;
}

// ─── API Helpers ─────────────────────────────────────────────────

/** List all exported company packages */
export function listExportedPackages(): Array<{ id: string; name: string; path: string; exportedAt: string }> {
    const exportsDir = join(TITAN_HOME, 'exports');
    if (!existsSync(exportsDir)) return [];

    const packages: Array<{ id: string; name: string; path: string; exportedAt: string }> = [];

    for (const entry of readdirSync(exportsDir)) {
        const pkgDir = join(exportsDir, entry);
        if (!statSync(pkgDir).isDirectory()) continue;

        const manifestPath = join(pkgDir, '.titan-company.yaml');
        if (existsSync(manifestPath)) {
            const yaml = readFileSync(manifestPath, 'utf-8');
            const name = extractYamlValue(yaml, 'name') || entry;
            const id = extractYamlValue(yaml, 'id') || entry;
            const exportedAt = extractYamlValue(yaml, 'exportedAt') || new Date().toISOString();
            packages.push({ id, name, path: pkgDir, exportedAt });
        }
    }

    return packages.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt));
}
