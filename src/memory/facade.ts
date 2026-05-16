/**
 * TITAN — Memory Façade (v6.1.0-beta.14, Phase D.2)
 *
 * A clean three-layer API on top of TITAN's existing memory stores.
 * Hermes Agent and most reliable agent frameworks expose memory as
 * working / episodic / semantic — this façade gives TITAN the same
 * legibility without re-implementing any of the underlying stores.
 *
 * THREE LAYERS:
 *
 *   memory.working     — In-flight, session-scoped state.
 *                        Open questions, decisions, artifacts produced
 *                        during the current spawn. Cleared on session
 *                        close. Lives in workingMemory.ts.
 *
 *   memory.episodic    — Past interactions: "what happened when".
 *                        Recallable by time-window or vector similarity.
 *                        Backed by episodic.ts + Hindsight cross-session
 *                        bridge. Persisted to disk.
 *
 *   memory.semantic    — Facts, learned patterns, user model.
 *                        "Tony's daughter is named Y", "the project uses
 *                        TypeScript", "this tool fails 30 % of the time".
 *                        Backed by memory.rememberFact + relationship.ts
 *                        + learning.ts. Persisted.
 *
 * WHY this façade exists:
 *
 *   - The Picrew/awesome-agent-harness catalog identifies three-layer
 *     memory as the canonical shape. Hermes specifically calls it out
 *     as their headline differentiator. TITAN's underlying stores are
 *     more featureful than Hermes's (graph + briefings + Hindsight)
 *     but LESS LEGIBLE — a new contributor reading the code has to
 *     chase six imports to find "where does TITAN remember things".
 *
 *   - This façade is the public surface new code uses. Internal modules
 *     still call the underlying functions directly — we don't break
 *     anything. New skills, new providers, new specialist prompts all
 *     get `import { memory } from '../memory/facade.js'` and a clean
 *     three-method API.
 *
 *   - Documentation now has a single, stable export to point at. The
 *     README + skill-author guide reference `memory.semantic.recallFact`
 *     instead of "wait, is that memory.ts or memory/relationship.ts?".
 *
 * TRADE-OFFS we deliberately accept:
 *
 *   - The façade is a thin wrapper, not a re-architecture. The methods
 *     pass straight through to the underlying functions. If you need
 *     a feature that doesn't fit one of the three layers cleanly
 *     (e.g. the memory graph's edge traversal), import that module
 *     directly. The façade covers the 90 % of read/write flows.
 *
 *   - Some methods are duplicated semantically — e.g. semantic.search
 *     and episodic.recallSimilar both do vector recall. The naming
 *     follows the layer's metaphor: a SEMANTIC search returns FACTS,
 *     an EPISODIC recall returns past EVENTS. They share infrastructure
 *     but the intent is different.
 *
 *   - Async/sync mix is preserved from the underlying functions.
 *     `recallSimilar` is async (vector store); `rememberFact` is sync
 *     (key-value SQLite). The façade doesn't normalize because that
 *     would force unnecessary `await`s on cheap paths.
 *
 * FOLLOW-UP:
 *
 *   - Skill authors guide updates to reference `memory.*` exclusively.
 *   - System prompt includes can call `memory.episodic.renderRecallBlock`
 *     directly instead of importing episodic.ts.
 *   - `memory.consolidate()` shortcut wired to dreaming.runConsolidation.
 *   - `memory.graph` namespace if anyone needs structured edge queries.
 */

// ── Working layer — workingMemory.ts ──
import {
    openSession,
    recordDecision,
    recordOpenQuestion,
    resolveOpenQuestion,
    recordArtifact,
    addNote,
    updateStatus,
    closeSession,
    retireStaleSessions,
} from './workingMemory.js';

// ── Episodic layer — episodic.ts + hindsightBridge.ts ──
import {
    recordEpisode,
    recallSimilarEpisodes,
    recallRecent,
    renderRecallBlock,
} from './episodic.js';
import {
    isHindsightConnected,
    retainToHindsight,
    recallFromHindsight,
    retainStrategy,
    getHindsightHints,
} from './hindsightBridge.js';

// ── Semantic layer — memory.ts + relationship.ts + learning.ts ──
import {
    rememberFact,
    recallFact,
    searchMemories,
} from './memory.js';
import {
    loadProfile,
    saveProfile,
    learnName,
    rememberProject,
    rememberContact,
    learnPreference,
    learnFact as learnUserFact,
    addGoal,
    calibrateTechnicalLevel,
    type PersonalProfile,
} from './relationship.js';
import {
    recordToolResult,
    recordSuccessPattern,
    recordUserCorrection,
} from './learning.js';

/* ──────────────────────────  Working layer  ────────────────────────── */

/**
 * In-flight, session-scoped memory. Cleared when the session closes.
 * Use this for: "what decisions has the agent made this turn", "what
 * files has it produced", "what's it still waiting on".
 *
 * Sessions are usually a Mission Chat thread or a sub-agent spawn,
 * but anything with a clear start/end can open one.
 */
export const working = {
    /** Open a new working-memory session. */
    openSession,
    /** Record a decision the agent made during this session. */
    recordDecision,
    /** Note a question the agent needs answered to proceed. */
    recordOpenQuestion,
    /** Mark an open question as answered. */
    resolveOpenQuestion,
    /** Note an artifact (file, URL, fact id) the agent produced. */
    recordArtifact,
    /** Free-form breadcrumb. */
    addNote,
    /** Update the session's status. */
    updateStatus,
    /** Close the session. Returns the final record. */
    closeSession,
    /** Sweep + archive sessions idle longer than the configured TTL. */
    retireStale: retireStaleSessions,
};

/* ──────────────────────────  Episodic layer  ────────────────────────── */

/**
 * Past interactions. Recallable by recency or by vector similarity
 * against the current task. Persisted to disk.
 *
 * The cross-session bridge (Hindsight) lets TITAN recall things it
 * learned in a different process — e.g. "last week's strategy for
 * this customer".
 */
export const episodic = {
    /** Record a new episode (past interaction, decision, observation). */
    record: recordEpisode,
    /** Recall episodes most similar to a query (vector search). */
    recallSimilar: recallSimilarEpisodes,
    /** Recall the N most recent episodes. */
    recallRecent,
    /**
     * Render a markdown block of recalled episodes suitable for
     * injection into a system prompt. Wraps recallRecent +
     * recallSimilar with the right formatting.
     */
    renderRecallBlock,
    /** Cross-session retention via the Hindsight bridge. */
    retain: retainToHindsight,
    /** Cross-session recall. Returns null if not connected. */
    recallCrossSession: recallFromHindsight,
    /** Retain a STRATEGY (not just a memory) cross-session. */
    retainStrategy,
    /** Get cross-session hints relevant to a current message. */
    getCrossSessionHints: getHindsightHints,
    /** True if the Hindsight bridge has a working credential. */
    isCrossSessionConnected: isHindsightConnected,
};

/* ──────────────────────────  Semantic layer  ────────────────────────── */

/**
 * Facts, learned patterns, the user model. The agent's "knowledge"
 * as opposed to its "history". Persisted to disk.
 *
 * Two flavors of writes:
 *   - rememberFact: arbitrary key-value facts ("project.name", "TITAN").
 *   - learnUser*:   structured user-profile facts ("user prefers vim").
 *
 * Both are searchable via `search(query)`.
 */
export const semantic = {
    // ── Generic key-value facts ──
    /** Store a category/key fact. */
    rememberFact,
    /** Retrieve a category/key fact. */
    recallFact,
    /** Fuzzy search across all stored facts. */
    search: searchMemories,

    // ── User profile / relationship ──
    /** Load the persistent user profile (defaults to 'default' user). */
    getUserProfile: loadProfile,
    /** Save changes back to the user profile. */
    saveUserProfile: saveProfile,
    /** Learn the user's name. */
    learnUserName: learnName,
    /** Remember a project the user is working on. */
    learnUserProject: rememberProject,
    /** Remember a contact the user mentioned. */
    learnUserContact: rememberContact,
    /** Learn a user preference. */
    learnUserPreference: learnPreference,
    /** Learn a fact the user told us. */
    learnUserFact,
    /** Add a goal the user wants help with. */
    addUserGoal: addGoal,
    /** Calibrate technical level (beginner / intermediate / expert). */
    calibrateUserTechnicalLevel: calibrateTechnicalLevel,

    // ── Learned tool patterns ──
    /** Record a tool's outcome for the success-rate learner. */
    recordToolResult,
    /** Promote a tool sequence as a "good pattern" to prefer. */
    recordSuccessPattern,
    /** Record a user correction so the agent learns not to repeat it. */
    recordUserCorrection,
};

/* ──────────────────────────  Top-level facade  ────────────────────────── */

/**
 * The single export new code should reach for. Spelled lowercase so
 * call sites read like english:
 *
 *     import { memory } from '../memory/facade.js';
 *
 *     memory.working.recordDecision(sessionId, 'go with option A', 'cheaper');
 *     const past = await memory.episodic.recallSimilar('birthday parties');
 *     memory.semantic.learnUserPreference('tone', 'casual');
 */
export const memory = {
    working,
    episodic,
    semantic,
};

/* ──────────────────────────  Type re-exports  ────────────────────────── */

export type { PersonalProfile };
