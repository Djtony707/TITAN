/**
 * TITAN — User Skill Profile Manager
 * Tracks tool usage, skill level, preferences, and correction history.
 * Profile persisted to ~/.titan/user-profile.json.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { readJsonFile, writeJsonFile, mkdirIfNotExists } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const COMPONENT = 'UserProfile';
const PROFILE_PATH = join(TITAN_HOME, 'user-profile.json');

export interface Correction {
    context: string;
    correction: string;
    timestamp: number;
}

export interface UserProfile {
    /** Frequency map of tool name → usage count */
    toolUsage: Record<string, number>;
    /** Overall skill level derived from usage patterns */
    skillLevel: 'beginner' | 'intermediate' | 'advanced';
    /** User preferences (use case, display name, etc.) */
    preferences: Record<string, string>;
    /** History of user corrections for learning */
    corrections: Correction[];
    /** Whether first-run wizard has been completed */
    firstRunCompleted: boolean;
    /** ISO timestamp of profile creation */
    createdAt: string;
    /** ISO timestamp of last update */
    updatedAt: string;
}

function createDefaultProfile(): UserProfile {
    return {
        toolUsage: {},
        skillLevel: 'beginner',
        preferences: {},
        corrections: [],
        firstRunCompleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

let cachedProfile: UserProfile | null = null;

/** Load user profile from disk, creating default if missing */
export function loadProfile(): UserProfile {
    if (cachedProfile) return cachedProfile;

    mkdirIfNotExists(TITAN_HOME);

    if (existsSync(PROFILE_PATH)) {
        const loaded = readJsonFile<UserProfile>(PROFILE_PATH);
        if (loaded) {
            cachedProfile = loaded;
            logger.debug(COMPONENT, 'Loaded user profile');
            return cachedProfile;
        }
    }

    cachedProfile = createDefaultProfile();
    saveProfile(cachedProfile);
    logger.info(COMPONENT, 'Created new user profile');
    return cachedProfile;
}

/** Save user profile to disk */
export function saveProfile(profile: UserProfile): void {
    profile.updatedAt = new Date().toISOString();
    writeJsonFile(PROFILE_PATH, profile);
    cachedProfile = profile;
}

/** Record a tool usage event */
export function recordToolUsage(toolName: string): void {
    const profile = loadProfile();
    profile.toolUsage[toolName] = (profile.toolUsage[toolName] || 0) + 1;
    profile.skillLevel = deriveSkillLevel(profile);
    saveProfile(profile);
}

/** Record a user correction for future reference */
export function recordCorrection(context: string, correction: string): void {
    const profile = loadProfile();
    profile.corrections.push({
        context,
        correction,
        timestamp: Date.now(),
    });
    // Keep last 100 corrections
    if (profile.corrections.length > 100) {
        profile.corrections = profile.corrections.slice(-100);
    }
    saveProfile(profile);
}

/** Derive skill level from total tool usage */
export function deriveSkillLevel(profile: UserProfile): UserProfile['skillLevel'] {
    const totalUsage = Object.values(profile.toolUsage).reduce((a, b) => a + b, 0);
    const uniqueTools = Object.keys(profile.toolUsage).length;

    if (totalUsage >= 200 && uniqueTools >= 15) return 'advanced';
    if (totalUsage >= 50 && uniqueTools >= 8) return 'intermediate';
    return 'beginner';
}

/** Get current skill level */
export function getSkillLevel(): UserProfile['skillLevel'] {
    return loadProfile().skillLevel;
}

/** Get top N most-used tools */
export function getTopTools(n: number = 5): Array<{ name: string; count: number }> {
    const profile = loadProfile();
    return Object.entries(profile.toolUsage)
        .sort(([, a], [, b]) => b - a)
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));
}

/** Check if this is the first run */
export function isFirstRun(): boolean {
    return !loadProfile().firstRunCompleted;
}

/** Mark first-run wizard as completed */
export function completeFirstRun(): void {
    const profile = loadProfile();
    profile.firstRunCompleted = true;
    saveProfile(profile);
}

/** Clear cached profile (for testing) */
export function clearCache(): void {
    cachedProfile = null;
}
