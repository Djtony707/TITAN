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
 * Generate a SKILL.md file content from a trajectory.
 */
export function generateSkillContent(trajectory: TaskTrajectory): string {
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
export function saveGeneratedSkill(trajectory: TaskTrajectory): GeneratedSkill | null {
    try {
        const dirPath = join(SKILLS_DIR, skillDirName(trajectory.taskType, trajectory.toolSequence));
        const filePath = join(dirPath, 'SKILL.md');

        if (!existsSync(dirPath)) {
            mkdirSync(dirPath, { recursive: true });
        }

        const content = generateSkillContent(trajectory);
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
 */
export function processTrajectoryForSkills(trajectory: TaskTrajectory): void {
    if (shouldGenerateSkill(trajectory)) {
        saveGeneratedSkill(trajectory);
    }
}
