/**
 * TITAN — Agent Template Marketplace
 * Shareable agent persona bundles: personality + skills + model preferences + system prompt.
 * Templates can be installed from the marketplace and applied to sub-agents or the main agent.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'AgentTemplates';
const TEMPLATES_DIR = join(homedir(), '.titan', 'agent-templates');

export interface AgentTemplate {
    name: string;
    description: string;
    author?: string;
    version?: string;
    persona: {
        identity: string;         // Who the agent is
        style: string;            // How it communicates
        rules?: string[];         // Behavioral rules
    };
    skills?: string[];            // Required skill names
    model?: string;               // Preferred model
    modelTier?: string;           // cloud | smart | fast | local
    systemPromptAddition?: string; // Extra system prompt content
    tags?: string[];
    createdAt?: string;
}

/** Initialize templates directory */
function ensureDir(): void {
    if (!existsSync(TEMPLATES_DIR)) mkdirSync(TEMPLATES_DIR, { recursive: true });
}

/** List all installed agent templates */
export function listTemplates(): AgentTemplate[] {
    ensureDir();
    const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
        try {
            return JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8')) as AgentTemplate;
        } catch { return null; }
    }).filter((t): t is AgentTemplate => t !== null);
}

/** Get a specific template by name */
export function getTemplate(name: string): AgentTemplate | null {
    const path = join(TEMPLATES_DIR, `${name.toLowerCase().replace(/\s+/g, '-')}.json`);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

/** Save a template */
export function saveTemplate(template: AgentTemplate): void {
    ensureDir();
    template.createdAt = template.createdAt || new Date().toISOString();
    const filename = `${template.name.toLowerCase().replace(/\s+/g, '-')}.json`;
    writeFileSync(join(TEMPLATES_DIR, filename), JSON.stringify(template, null, 2), 'utf-8');
    logger.info(COMPONENT, `Template saved: ${template.name}`);
}

/** Delete a template */
export function deleteTemplate(name: string): boolean {
    const path = join(TEMPLATES_DIR, `${name.toLowerCase().replace(/\s+/g, '-')}.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
}

/** Convert a template to a system prompt fragment */
export function templateToPrompt(template: AgentTemplate): string {
    const parts: string[] = [];
    if (template.persona.identity) parts.push(`## Identity\n${template.persona.identity}`);
    if (template.persona.style) parts.push(`## Communication Style\n${template.persona.style}`);
    if (template.persona.rules?.length) parts.push(`## Rules\n${template.persona.rules.map(r => `- ${r}`).join('\n')}`);
    if (template.systemPromptAddition) parts.push(template.systemPromptAddition);
    return parts.join('\n\n');
}

// Built-in templates
export const BUILTIN_TEMPLATES: AgentTemplate[] = [
    {
        name: 'Code Architect',
        description: 'Expert software architect focused on clean code, SOLID principles, and scalable design.',
        persona: {
            identity: 'You are a senior software architect with 20 years of experience. You think in systems, not scripts.',
            style: 'Direct and technical. Use code examples. Explain trade-offs. Never over-engineer.',
            rules: ['Always consider scalability', 'Prefer composition over inheritance', 'Write tests for critical paths'],
        },
        skills: ['shell', 'read_file', 'write_file', 'edit_file', 'web_search'],
        modelTier: 'smart',
        tags: ['development', 'architecture'],
    },
    {
        name: 'Research Analyst',
        description: 'Deep researcher who synthesizes information from multiple sources into actionable insights.',
        persona: {
            identity: 'You are a research analyst. You find information, verify it, and present it clearly.',
            style: 'Thorough and evidence-based. Cite sources. Present multiple perspectives. Quantify when possible.',
            rules: ['Always verify claims with web_search', 'Present contrasting viewpoints', 'Include data and statistics'],
        },
        skills: ['web_search', 'web_fetch', 'write_file', 'memory'],
        modelTier: 'cloud',
        tags: ['research', 'analysis'],
    },
    {
        name: 'DevOps Engineer',
        description: 'Infrastructure and deployment specialist. Docker, CI/CD, monitoring.',
        persona: {
            identity: 'You are a DevOps engineer. You automate everything and monitor what you deploy.',
            style: 'Practical and script-heavy. Prefer shell commands over manual steps. Always verify.',
            rules: ['Test in staging before production', 'Use execute_code for complex automation', 'Always check logs after changes'],
        },
        skills: ['shell', 'execute_code', 'read_file', 'write_file', 'web_search'],
        modelTier: 'smart',
        tags: ['devops', 'infrastructure'],
    },
];
