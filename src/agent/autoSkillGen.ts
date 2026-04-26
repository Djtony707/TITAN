/**
 * TITAN — Auto-Skill Generation from Trajectories
 *
 * When a task type + tool sequence succeeds 3+ times, auto-generates a SKILL.md
 * at ~/.titan/workspace/skills/auto-{taskType}-{hash}/SKILL.md.
 *
 * On future tasks, matching skills are surfaced as guidance in the system prompt.
 * Inspired by Hermes skill_manager_tool.py.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { getRecentTrajectories, getSequenceSignature, countMatchingTrajectories, type TaskTrajectory } from './trajectoryLogger.js';
import { classifyTaskType } from '../memory/learning.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AutoSkillGen';
const SKILLS_DIR = join(homedir(), '.titan', 'workspace', 'skills');
const MIN_SUCCESSES = 3; // Minimum successful runs before generating a skill

// ── Types ─────────────────────────────────────────────────────────
export interface GeneratedSkill {
    name: string;
    description: string;
    taskType: string;
    toolSequence: string[];
    triggerPatterns: string[];
    successCount: number;
    avgRounds: number;
    generatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────
function skillHash(taskType: string, toolSequence: string[]): string {
    return createHash('md5')
        .update(`${taskType}:${toolSequence.join(',')}`)
        .digest('hex')
        .slice(0, 8);
}

function skillDirName(taskType: string, toolSequence: string[]): string {
    return `auto-${taskType}-${skillHash(taskType, toolSequence)}`;
}

function skillPath(taskType: string, toolSequence: string[]): string {
    return join(SKILLS_DIR, skillDirName(taskType, toolSequence), 'SKILL.md');
}

// ── Core Functions ────────────────────────────────────────────────

/**
 * Check if a skill should be generated for this trajectory.
 * Returns true if 3+ successful trajectories exist with the same
 * taskType + toolSequence and no auto-skill already exists.
 */
export function shouldGenerateSkill(trajectory: TaskTrajectory): boolean {
    if (!trajectory.success || trajectory.toolSequence.length < 2) return false;

    // Check if auto-skill already exists
    const path = skillPath(trajectory.taskType, trajectory.toolSequence);
    if (existsSync(path)) return false;

    // Count matching successful trajectories
    const count = countMatchingTrajectories(trajectory.taskType, trajectory.toolSequence);
    return count >= MIN_SUCCESSES;
}

/**
 * Generate a SKILL.md file content from a trajectory using the LLM.
 *
 * Competitive gap fix (Hermes): Hermes generates rich skills with edge cases,
 * verification steps, and failure modes via LLM. TITAN was template-only.
 * Now we send the trajectory to the `fast` model alias for rich generation,
 * with automatic fallback to the template if the LLM call fails.
 */
export async function generateSkillContent(trajectory: TaskTrajectory): Promise<string> {
    // Try LLM-enhanced generation first
    try {
        const config = loadConfig();
        const aliases = (config.agent as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
        const fastModel = aliases?.fast || 'ollama/qwen3.5:cloud';

        const llmContent = await generateSkillWithLLM(trajectory, fastModel);
        if (llmContent && llmContent.length > 200) {
            logger.info(COMPONENT, `LLM-enhanced skill generated (${llmContent.length} chars) for ${trajectory.taskType}`);
            return llmContent;
        }
    } catch (err) {
        logger.warn(COMPONENT, `LLM skill generation failed, falling back to template: ${(err as Error).message}`);
    }

    // Fallback: template-based generation (original behavior)
    return generateSkillTemplate(trajectory);
}

/**
 * LLM-enhanced skill generation — sends the trajectory to the fast model
 * and gets back a rich SKILL.md with edge cases, pitfalls, and verification.
 */
async function generateSkillWithLLM(trajectory: TaskTrajectory, model: string): Promise<string> {
    // Dynamic import to avoid circular dependency at module load
    const { chat } = await import('../providers/router.js');

    const matchingTrajectories = getRecentTrajectories(50, {
        taskType: trajectory.taskType,
        success: true,
    }).filter(t => getSequenceSignature(t.toolSequence) === getSequenceSignature(trajectory.toolSequence));

    const avgRounds = matchingTrajectories.length > 0
        ? Math.round(matchingTrajectories.reduce((sum, t) => sum + t.rounds, 0) / matchingTrajectories.length)
        : trajectory.rounds;

    const toolDetails = trajectory.toolSequence.map((tool, i) => {
        const detail = trajectory.toolDetails[i];
        const argsPreview = detail
            ? JSON.stringify(detail.args).slice(0, 200)
            : '{}';
        const resultPreview = detail?.resultSnippet || '';
        return `Step ${i + 1}: ${tool}(${argsPreview})${resultPreview ? ` → ${resultPreview.slice(0, 100)}` : ''}`;
    }).join('\n');

    const prompt = `You are a skill documentation writer for the TITAN AI agent framework.

A task has been completed successfully ${matchingTrajectories.length} times using this tool sequence.
Write a reusable SKILL.md that future agents can follow.

## Task Details
- **Task type**: ${trajectory.taskType}
- **User request**: ${trajectory.task.slice(0, 300)}
- **Tool sequence**: ${trajectory.toolSequence.join(' → ')}
- **Rounds**: ${avgRounds} average
- **Duration**: ${Math.round(trajectory.durationMs / 1000)}s

## Tool Call Details
${toolDetails}

## Required Output Format
Write a SKILL.md with YAML frontmatter. Include these sections:
1. **Trigger Patterns** — when should this skill be applied (2-4 bullet points)
2. **Procedure** — step-by-step with the exact tool sequence and key arguments
3. **Common Pitfalls** — what goes wrong and how to avoid it (2-3 items)
4. **Verification** — how to confirm the task succeeded (1-2 checks)
5. **Statistics** — success count, avg rounds, avg duration

Start with:
---
name: ${skillDirName(trajectory.taskType, trajectory.toolSequence)}
description: <one-line description>
version: 1.0.0
author: TITAN AutoSkill
category: auto-generated
---

Keep it concise — under 60 lines total. No filler.`;

    const response = await chat({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 1500,
    });

    return response.content || '';
}

/**
 * Template-based skill generation (original behavior, used as fallback).
 */
function generateSkillTemplate(trajectory: TaskTrajectory): string {
    const matchingTrajectories = getRecentTrajectories(50, {
        taskType: trajectory.taskType,
        success: true,
    }).filter(t => getSequenceSignature(t.toolSequence) === getSequenceSignature(trajectory.toolSequence));

    const avgRounds = matchingTrajectories.length > 0
        ? Math.round(matchingTrajectories.reduce((sum, t) => sum + t.rounds, 0) / matchingTrajectories.length)
        : trajectory.rounds;

    const avgDurationMs = matchingTrajectories.length > 0
        ? Math.round(matchingTrajectories.reduce((sum, t) => sum + t.durationMs, 0) / matchingTrajectories.length)
        : trajectory.durationMs;

    const steps = trajectory.toolSequence.map((tool, i) => {
        const detail = trajectory.toolDetails[i];
        const argsPreview = detail
            ? Object.keys(detail.args).slice(0, 3).join(', ')
            : '';
        return `${i + 1}. **${tool}**${argsPreview ? ` — args: ${argsPreview}` : ''}`;
    }).join('\n');

    return `---
name: ${skillDirName(trajectory.taskType, trajectory.toolSequence)}
description: Auto-generated skill for ${trajectory.taskType} tasks using ${trajectory.toolSequence.join(' → ')}
version: 1.0.0
author: TITAN AutoSkill
category: auto-generated
---

# ${trajectory.taskType} Task Pattern

Proven tool sequence for this type of task:

${steps}

## Statistics
- **Success rate**: ${matchingTrajectories.length} successful runs
- **Average rounds**: ${avgRounds}
- **Average duration**: ${Math.round(avgDurationMs / 1000)}s
- **Generated**: ${new Date().toISOString()}

## When to use
Apply this sequence when the user asks for a ${trajectory.taskType} task that involves ${trajectory.toolSequence.slice(0, 3).join(', ')}.
`;
}

/**
 * Save a generated skill to disk.
 */
export async function saveGeneratedSkill(trajectory: TaskTrajectory): Promise<GeneratedSkill | null> {
    try {
        const dirPath = join(SKILLS_DIR, skillDirName(trajectory.taskType, trajectory.toolSequence));
        const filePath = join(dirPath, 'SKILL.md');

        if (!existsSync(dirPath)) {
            mkdirSync(dirPath, { recursive: true });
        }

        const content = await generateSkillContent(trajectory);
        writeFileSync(filePath, content, 'utf-8');

        const skill: GeneratedSkill = {
            name: skillDirName(trajectory.taskType, trajectory.toolSequence),
            description: `Auto-generated skill for ${trajectory.taskType} tasks`,
            taskType: trajectory.taskType,
            toolSequence: trajectory.toolSequence,
            triggerPatterns: [trajectory.taskType],
            successCount: countMatchingTrajectories(trajectory.taskType, trajectory.toolSequence),
            avgRounds: trajectory.rounds,
            generatedAt: new Date().toISOString(),
        };

        logger.info(COMPONENT, `Generated auto-skill: ${skill.name} (${skill.toolSequence.join(' → ')})`);
        return skill;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to save auto-skill: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Find auto-generated skills matching a message and task type.
 */
export function findMatchingSkills(message: string, taskType: string): GeneratedSkill[] {
    if (!existsSync(SKILLS_DIR)) return [];

    const results: GeneratedSkill[] = [];
    try {
        const dirs = readdirSync(SKILLS_DIR).filter(d => d.startsWith('auto-'));
        for (const dir of dirs) {
            const skillFile = join(SKILLS_DIR, dir, 'SKILL.md');
            if (!existsSync(skillFile)) continue;

            try {
                const content = readFileSync(skillFile, 'utf-8');
                // Parse frontmatter
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (!fmMatch) continue;

                const fm = fmMatch[1];
                const descMatch = fm.match(/description:\s*(.+)/);
                const description = descMatch?.[1] || '';

                // Check if this skill matches the task type
                if (!dir.includes(taskType) && !description.toLowerCase().includes(taskType)) continue;

                // Parse tool sequence from the skill content
                const toolMatches = content.match(/\*\*(\w+)\*\*/g);
                const toolSequence = toolMatches
                    ? toolMatches.map(m => m.replace(/\*\*/g, '')).filter(t => !['Success', 'Average', 'Generated', 'When'].includes(t))
                    : [];

                const successMatch = content.match(/(\d+) successful runs/);
                const roundsMatch = content.match(/Average rounds.*?(\d+)/);

                results.push({
                    name: dir,
                    description,
                    taskType,
                    toolSequence,
                    triggerPatterns: [taskType],
                    successCount: successMatch ? parseInt(successMatch[1]) : 0,
                    avgRounds: roundsMatch ? parseInt(roundsMatch[1]) : 0,
                    generatedAt: '',
                });
            } catch { /* skip malformed skill files */ }
        }
    } catch { /* skills dir read error */ }

    return results;
}

/**
 * Get skill guidance string for injection into the system prompt.
 * Returns null if no matching skills found.
 */
export function getSkillGuidance(message: string): string | null {
    const taskType = classifyTaskType(message);
    const skills = findMatchingSkills(message, taskType);

    if (skills.length === 0) return null;

    const best = skills.sort((a, b) => b.successCount - a.successCount)[0];
    return `For similar ${best.taskType} tasks, a proven approach: ${best.toolSequence.join(' → ')} (${best.successCount} successful runs, ~${best.avgRounds} rounds). Auto-generated from past trajectories.`;
}

/**
 * Process a trajectory: log it, check if a skill should be generated, generate if so.
 * This is the main entry point called from agent.ts after each task.
 * Runs async (LLM call for rich skill generation) but fire-and-forget — never blocks the agent response.
 */
export function processTrajectoryForSkills(trajectory: TaskTrajectory): void {
    if (shouldGenerateSkill(trajectory)) {
        // Fire-and-forget: don't block the agent response on skill generation
        saveGeneratedSkill(trajectory).catch(err => {
            logger.warn(COMPONENT, `Auto-skill generation failed: ${(err as Error).message}`);
        });
    }
}
