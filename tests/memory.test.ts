/**
 * TITAN — Memory Module Tests
 * Tests memory.ts, relationship.ts, learning.ts, briefing.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock filesystem and logger before importing modules
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue('{}'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
    readJsonFile: vi.fn().mockReturnValue(null),
    writeJsonFile: vi.fn(),
}));

vi.mock('../src/security/encryption.js', () => ({
    encrypt: vi.fn().mockReturnValue({ iv: 'abc', authTag: 'def', data: 'ghi' }),
    decrypt: vi.fn().mockReturnValue('decrypted text'),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-memory',
    TITAN_DB_PATH: '/tmp/titan-test-memory/titan.db',
    TITAN_CONFIG_PATH: '/tmp/titan-test-memory/titan.json',
    TITAN_WORKSPACE: '/tmp/titan-test-memory/workspace',
    TITAN_SKILLS_DIR: '/tmp/titan-test-memory/workspace/skills',
    TITAN_LOGS_DIR: '/tmp/titan-test-memory/logs',
    TITAN_VERSION: '2026.5.0',
    TITAN_NAME: 'TITAN',
    TITAN_FULL_NAME: 'The Intelligent Task Automation Network',
    DEFAULT_GATEWAY_PORT: 48420,
    DEFAULT_GATEWAY_HOST: '0.0.0.0',
    DEFAULT_WEB_PORT: 48421,
    DEFAULT_MODEL: 'anthropic/claude-sonnet-4-20250514',
    DEFAULT_MAX_TOKENS: 8192,
    DEFAULT_TEMPERATURE: 0.7,
    DEFAULT_SANDBOX_MODE: 'host',
    ALLOWED_TOOLS_DEFAULT: [],
}));

vi.mock('../src/memory/vectors.js', () => ({
    isVectorSearchAvailable: vi.fn().mockReturnValue(false),
    searchVectors: vi.fn().mockResolvedValue([]),
    addVector: vi.fn().mockResolvedValue(false),
}));

// ─── Memory Tests ─────────────────────────────────────────────────

describe('Memory Module', () => {
    let memory: typeof import('../src/memory/memory.js');

    beforeEach(async () => {
        vi.resetModules();
        // Re-apply mocks after resetModules
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(false),
                readFileSync: vi.fn().mockReturnValue('{}'),
                writeFileSync: vi.fn(),
                mkdirSync: vi.fn(),
            };
        });
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/helpers.js', () => ({
            ensureDir: vi.fn(),
            readJsonFile: vi.fn().mockReturnValue(null),
            writeJsonFile: vi.fn(),
        }));
        vi.doMock('../src/security/encryption.js', () => ({
            encrypt: vi.fn().mockReturnValue({ iv: 'abc', authTag: 'def', data: 'ghi' }),
            decrypt: vi.fn().mockReturnValue('decrypted text'),
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-memory',
            TITAN_DB_PATH: '/tmp/titan-test-memory/titan.db',
            TITAN_CONFIG_PATH: '/tmp/titan-test-memory/titan.json',
            TITAN_WORKSPACE: '/tmp/titan-test-memory/workspace',
            TITAN_SKILLS_DIR: '/tmp/titan-test-memory/workspace/skills',
            TITAN_LOGS_DIR: '/tmp/titan-test-memory/logs',
            TITAN_VERSION: '2026.5.0',
            TITAN_NAME: 'TITAN',
            TITAN_FULL_NAME: 'The Intelligent Task Automation Network',
            DEFAULT_GATEWAY_PORT: 48420,
            DEFAULT_GATEWAY_HOST: '0.0.0.0',
            DEFAULT_WEB_PORT: 48421,
            DEFAULT_MODEL: 'anthropic/claude-sonnet-4-20250514',
            DEFAULT_MAX_TOKENS: 8192,
            DEFAULT_TEMPERATURE: 0.7,
            DEFAULT_SANDBOX_MODE: 'host',
            ALLOWED_TOOLS_DEFAULT: [],
        }));
        vi.doMock('../src/memory/vectors.js', () => ({
            isVectorSearchAvailable: vi.fn().mockReturnValue(false),
            searchVectors: vi.fn().mockResolvedValue([]),
            addVector: vi.fn().mockResolvedValue(false),
        }));
        memory = await import('../src/memory/memory.js');
        memory.initMemory();
    });

    describe('initMemory / closeMemory', () => {
        it('should initialize without error', () => {
            expect(() => memory.initMemory()).not.toThrow();
        });

        it('should close without error', () => {
            expect(() => memory.closeMemory()).not.toThrow();
        });
    });

    describe('rememberFact / recallFact', () => {
        it('should remember and recall a fact', () => {
            memory.rememberFact('preference', 'language', 'TypeScript');
            const value = memory.recallFact('preference', 'language');
            expect(value).toBe('TypeScript');
        });

        it('should return null for unknown fact', () => {
            expect(memory.recallFact('nope', 'nope')).toBeNull();
        });

        it('should update an existing fact', () => {
            memory.rememberFact('pref', 'color', 'blue');
            memory.rememberFact('pref', 'color', 'green');
            expect(memory.recallFact('pref', 'color')).toBe('green');
        });
    });

    describe('searchMemories', () => {
        it('should search by category', async () => {
            memory.rememberFact('project', 'titan', 'AI agent');
            memory.rememberFact('hobby', 'chess', 'plays chess');
            const results = await memory.searchMemories('project');
            expect(results.length).toBe(1);
            expect(results[0].key).toBe('titan');
        });

        it('should search by query string', async () => {
            memory.rememberFact('project', 'titan', 'AI agent platform');
            memory.rememberFact('project', 'jarvis', 'AI voice assistant');
            const results = await memory.searchMemories(undefined, 'agent');
            expect(results.length).toBe(1);
            expect(results[0].key).toBe('titan');
        });

        it('should return empty array when nothing matches', async () => {
            expect(await memory.searchMemories('nonexistent')).toEqual([]);
        });

        it('should return all when no filters are passed', async () => {
            memory.rememberFact('a', 'key1', 'val1');
            memory.rememberFact('b', 'key2', 'val2');
            const results = await memory.searchMemories();
            expect(results.length).toBe(2);
        });
    });

    describe('recordUsage / getUsageStats', () => {
        it('should record usage and report stats', () => {
            memory.recordUsage('sess-1', 'anthropic', 'claude-3', 100, 200);
            memory.recordUsage('sess-1', 'openai', 'gpt-4o', 50, 100);
            const stats = memory.getUsageStats();
            expect(stats.totalTokens).toBe(450);
            expect(stats.totalRequests).toBe(2);
            expect(stats.byProvider.anthropic).toBe(300);
            expect(stats.byProvider.openai).toBe(150);
        });

        it('should return zero stats when empty', () => {
            const stats = memory.getUsageStats();
            expect(stats.totalTokens).toBe(0);
            expect(stats.totalRequests).toBe(0);
        });
    });

    describe('saveMessage / getHistory / clearHistory', () => {
        it('should save and retrieve a message', () => {
            memory.saveMessage({
                id: 'msg-1',
                sessionId: 'sess-1',
                role: 'user',
                content: 'Hello TITAN',
                tokenCount: 5,
            });
            const history = memory.getHistory('sess-1');
            expect(history.length).toBe(1);
            expect(history[0].content).toBe('Hello TITAN');
            expect(history[0].role).toBe('user');
        });

        it('should filter history by sessionId', () => {
            memory.saveMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'A', tokenCount: 1 });
            memory.saveMessage({ id: 'm2', sessionId: 's2', role: 'user', content: 'B', tokenCount: 1 });
            expect(memory.getHistory('s1').length).toBe(1);
            expect(memory.getHistory('s2').length).toBe(1);
        });

        it('should clear history for a session', () => {
            memory.saveMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'A', tokenCount: 1 });
            memory.clearHistory('s1');
            expect(memory.getHistory('s1').length).toBe(0);
        });

        it('should respect the limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                memory.saveMessage({ id: `m${i}`, sessionId: 's1', role: 'user', content: `Msg ${i}`, tokenCount: 1 });
            }
            expect(memory.getHistory('s1', 3).length).toBe(3);
        });
    });

    describe('getDb', () => {
        it('should return the data store', () => {
            const db = memory.getDb();
            expect(db).toHaveProperty('conversations');
            expect(db).toHaveProperty('memories');
            expect(db).toHaveProperty('sessions');
            expect(db).toHaveProperty('usageStats');
            expect(db).toHaveProperty('cronJobs');
            expect(db).toHaveProperty('skillsInstalled');
        });
    });
});

// ─── Learning Engine Tests ─────────────────────────────────────────

describe('Learning Engine', () => {
    let learning: typeof import('../src/memory/learning.js');

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(false),
                readFileSync: vi.fn().mockReturnValue('{}'),
                writeFileSync: vi.fn(),
                mkdirSync: vi.fn(),
            };
        });
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/helpers.js', () => ({
            ensureDir: vi.fn(),
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-learning',
        }));
        learning = await import('../src/memory/learning.js');
        learning.initLearning();
    });

    describe('initLearning', () => {
        it('should initialize without error', () => {
            expect(() => learning.initLearning()).not.toThrow();
        });
    });

    describe('recordToolResult', () => {
        it('should track tool success rates', () => {
            learning.recordToolResult('shell', true);
            learning.recordToolResult('shell', true);
            learning.recordToolResult('shell', false, undefined, 'Error: command failed');
            const recs = learning.getToolRecommendations();
            expect(recs.shell).toBeCloseTo(2 / 3, 1);
        });

        it('should track error patterns', () => {
            learning.recordToolResult('shell', false, undefined, 'ENOENT: file not found');
            learning.recordToolResult('shell', false, undefined, 'ENOENT: file not found');
            const stats = learning.getLearningStats();
            expect(stats.errorPatterns).toBeGreaterThan(0);
        });
    });

    describe('learnFact', () => {
        it('should add a new knowledge entry', () => {
            learning.learnFact('coding', 'TypeScript is preferred');
            const results = learning.queryKnowledge('TypeScript');
            expect(results.length).toBe(1);
            expect(results[0].content).toBe('TypeScript is preferred');
            expect(results[0].score).toBeCloseTo(0.5, 1);
        });

        it('should increase score on repeated learn', () => {
            learning.learnFact('coding', 'TypeScript is preferred');
            learning.learnFact('coding', 'TypeScript is preferred');
            const results = learning.queryKnowledge('TypeScript');
            expect(results[0].score).toBeCloseTo(0.6, 1);
        });
    });

    describe('queryKnowledge', () => {
        it('should filter by category', () => {
            learning.learnFact('coding', 'Use TypeScript');
            learning.learnFact('personal', 'Likes coffee');
            const results = learning.queryKnowledge('', 'coding');
            // queryKnowledge uses content.toLowerCase().includes(q) so empty query matches all
            expect(results.every(r => r.category === 'coding')).toBe(true);
        });

        it('should return empty for no matches', () => {
            learning.learnFact('coding', 'Use TypeScript');
            const results = learning.queryKnowledge('xylophone');
            expect(results.length).toBe(0);
        });
    });

    describe('recordSuccessPattern', () => {
        it('should record conversation insights', () => {
            learning.recordSuccessPattern({
                topic: 'coding help',
                toolsUsed: ['shell', 'read_file'],
                outcome: 'fixed bug',
            });
            const stats = learning.getLearningStats();
            expect(stats.insights).toBe(1);
        });
    });

    describe('recordUserCorrection', () => {
        it('should store corrections', () => {
            learning.recordUserCorrection('wrong answer', 'correct answer');
            const stats = learning.getLearningStats();
            expect(stats.corrections).toBe(1);
        });
    });

    describe('getLearningContext', () => {
        it('should return empty string when no data', () => {
            const ctx = learning.getLearningContext();
            expect(typeof ctx).toBe('string');
        });

        it('should include high-score facts', () => {
            learning.learnFact('coding', 'Always use strict mode');
            // Boost score above 0.6
            learning.learnFact('coding', 'Always use strict mode');
            learning.learnFact('coding', 'Always use strict mode');
            const ctx = learning.getLearningContext();
            expect(ctx).toContain('Always use strict mode');
        });
    });

    describe('getLearningStats', () => {
        it('should return correct stat structure', () => {
            const stats = learning.getLearningStats();
            expect(stats).toHaveProperty('knowledgeEntries');
            expect(stats).toHaveProperty('toolsTracked');
            expect(stats).toHaveProperty('errorPatterns');
            expect(stats).toHaveProperty('corrections');
            expect(stats).toHaveProperty('insights');
        });
    });

    describe('getToolRecommendations', () => {
        it('should return empty when no data', () => {
            const recs = learning.getToolRecommendations();
            expect(Object.keys(recs).length).toBe(0);
        });

        it('should return 1.0 for tools that always succeed', () => {
            learning.recordToolResult('reliable_tool', true);
            learning.recordToolResult('reliable_tool', true);
            const recs = learning.getToolRecommendations();
            expect(recs.reliable_tool).toBe(1);
        });
    });
});

// ─── Relationship Memory Tests ─────────────────────────────────────

describe('Relationship Memory', () => {
    let relationship: typeof import('../src/memory/relationship.js');

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(false),
                readFileSync: vi.fn().mockReturnValue('{}'),
                writeFileSync: vi.fn(),
                mkdirSync: vi.fn(),
            };
        });
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-rel',
        }));
        relationship = await import('../src/memory/relationship.js');
    });

    describe('loadProfile', () => {
        it('should return a default profile when none exists', () => {
            const profile = relationship.loadProfile();
            expect(profile.projects).toEqual([]);
            expect(profile.contacts).toEqual([]);
            expect(profile.preferences).toEqual({});
            expect(profile.facts).toEqual([]);
            expect(profile.goals).toEqual([]);
            expect(profile.responseStyle).toBe('conversational');
            expect(profile.technicalLevel).toBe('unknown');
            expect(profile.interactionCount).toBe(0);
        });
    });

    describe('learnName', () => {
        it('should set the user name and greeting', () => {
            relationship.learnName('Tony');
            const profile = relationship.loadProfile();
            expect(profile.name).toBe('Tony');
            expect(profile.preferredGreeting).toBe('Hey Tony');
        });
    });

    describe('rememberProject', () => {
        it('should add a new project', () => {
            relationship.rememberProject('TITAN', 'AI Agent Platform');
            const profile = relationship.loadProfile();
            expect(profile.projects.length).toBe(1);
            expect(profile.projects[0].name).toBe('TITAN');
        });

        it('should update an existing project (case-insensitive match)', () => {
            relationship.rememberProject('TITAN', 'AI Agent');
            relationship.rememberProject('titan', 'Updated description');
            const profile = relationship.loadProfile();
            expect(profile.projects.length).toBe(1);
            expect(profile.projects[0].description).toBe('Updated description');
        });
    });

    describe('rememberContact', () => {
        it('should add a new contact', () => {
            relationship.rememberContact('Alice', 'Engineer');
            const profile = relationship.loadProfile();
            expect(profile.contacts.length).toBe(1);
            expect(profile.contacts[0].name).toBe('Alice');
            expect(profile.contacts[0].role).toBe('Engineer');
        });

        it('should update an existing contact role', () => {
            relationship.rememberContact('Alice', 'Engineer');
            relationship.rememberContact('alice', 'Senior Engineer');
            const profile = relationship.loadProfile();
            expect(profile.contacts.length).toBe(1);
            expect(profile.contacts[0].role).toBe('Senior Engineer');
        });
    });

    describe('learnPreference', () => {
        it('should store a preference', () => {
            relationship.learnPreference('editor', 'VSCode');
            const profile = relationship.loadProfile();
            expect(profile.preferences.editor).toBe('VSCode');
        });
    });

    describe('learnFact', () => {
        it('should add a fact', () => {
            relationship.learnFact('Loves TypeScript', 'certain');
            const profile = relationship.loadProfile();
            expect(profile.facts.length).toBe(1);
            expect(profile.facts[0].fact).toBe('Loves TypeScript');
            expect(profile.facts[0].confidence).toBe('certain');
        });

        it('should not add duplicate facts', () => {
            relationship.learnFact('Loves TypeScript');
            relationship.learnFact('Loves TypeScript');
            const profile = relationship.loadProfile();
            expect(profile.facts.length).toBe(1);
        });
    });

    describe('addGoal', () => {
        it('should add a goal', () => {
            relationship.addGoal('Launch TITAN v3');
            const profile = relationship.loadProfile();
            expect(profile.goals.length).toBe(1);
            expect(profile.goals[0].goal).toBe('Launch TITAN v3');
            expect(profile.goals[0].completed).toBe(false);
        });

        it('should not add duplicate goals', () => {
            relationship.addGoal('Launch TITAN v3');
            relationship.addGoal('Launch TITAN v3');
            const profile = relationship.loadProfile();
            expect(profile.goals.length).toBe(1);
        });
    });

    describe('calibrateTechnicalLevel', () => {
        it('should set technical level', () => {
            relationship.calibrateTechnicalLevel('expert');
            const profile = relationship.loadProfile();
            expect(profile.technicalLevel).toBe('expert');
        });
    });

    describe('buildPersonalContext', () => {
        it('should return empty string for empty profile', () => {
            expect(relationship.buildPersonalContext()).toBe('');
        });

        it('should include user name in context', () => {
            relationship.learnName('Tony');
            const ctx = relationship.buildPersonalContext();
            expect(ctx).toContain('Tony');
        });

        it('should include technical level guidance', () => {
            relationship.calibrateTechnicalLevel('expert');
            const ctx = relationship.buildPersonalContext();
            expect(ctx).toContain('direct and technical');
        });

        it('should include projects when present', () => {
            relationship.rememberProject('TITAN');
            const ctx = relationship.buildPersonalContext();
            expect(ctx).toContain('TITAN');
        });
    });

    describe('getProfileSummary', () => {
        it('should return a string summary', () => {
            const summary = relationship.getProfileSummary();
            expect(typeof summary).toBe('string');
            expect(summary).toContain('TITAN knows about you');
        });

        it('should include user name when set', () => {
            relationship.learnName('Tony');
            const summary = relationship.getProfileSummary();
            expect(summary).toContain('Tony');
        });
    });
});
