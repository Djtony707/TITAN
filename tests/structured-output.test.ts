/**
 * TITAN — Structured Output / JSON Mode Skill Tests
 * Covers tool registration, extraction, transformation, validation,
 * error handling, and edge cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        providers: {},
        security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
        skills: {},
    }),
}));

// ─── Helpers ────────────────────────────────────────────────────────

let handlers: Map<string, any>;

async function loadSkill() {
    vi.resetModules();

    vi.doMock('../src/utils/logger.js', () => ({
        default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    handlers = new Map();
    vi.doMock('../src/skills/registry.js', () => ({
        registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
            handlers.set(handler.name, handler);
        }),
    }));

    const mod = await import('../src/skills/builtin/structured_output.js');
    mod.registerStructuredOutputSkill();
    return mod;
}

// ═════════════════════════════════════════════════════════════════════
// Tool Registration
// ═════════════════════════════════════════════════════════════════════

describe('Structured Output — Tool Registration', () => {
    beforeEach(async () => {
        await loadSkill();
    });

    it('should register the json_extract tool', () => {
        expect(handlers.get('json_extract')).toBeDefined();
        expect(handlers.get('json_extract').name).toBe('json_extract');
    });

    it('should register the json_transform tool', () => {
        expect(handlers.get('json_transform')).toBeDefined();
        expect(handlers.get('json_transform').name).toBe('json_transform');
    });

    it('should register the validate_json tool', () => {
        expect(handlers.get('validate_json')).toBeDefined();
        expect(handlers.get('validate_json').name).toBe('validate_json');
    });

    it('should require text and schema for json_extract', () => {
        const params = handlers.get('json_extract').parameters;
        expect(params.required).toContain('text');
        expect(params.required).toContain('schema');
    });

    it('should require input and instructions for json_transform', () => {
        const params = handlers.get('json_transform').parameters;
        expect(params.required).toContain('input');
        expect(params.required).toContain('instructions');
    });

    it('should require data and schema for validate_json', () => {
        const params = handlers.get('validate_json').parameters;
        expect(params.required).toContain('data');
        expect(params.required).toContain('schema');
    });
});

// ═════════════════════════════════════════════════════════════════════
// json_extract
// ═════════════════════════════════════════════════════════════════════

describe('Structured Output — json_extract', () => {
    beforeEach(async () => {
        await loadSkill();
    });

    it('should return an LLM prompt with the schema and text embedded', async () => {
        const handler = handlers.get('json_extract');
        const result = await handler.execute({
            text: 'John Doe, age 30, email john@example.com',
            schema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'integer' },
                    email: { type: 'string' },
                },
                required: ['name', 'age', 'email'],
            },
        });

        const parsed = JSON.parse(result);
        expect(parsed._action).toBe('llm_prompt');
        expect(parsed.prompt).toContain('John Doe');
        expect(parsed.prompt).toContain('SCHEMA');
        expect(parsed.schema).toBeDefined();
    });

    it('should return error for empty text', async () => {
        const handler = handlers.get('json_extract');
        const result = await handler.execute({ text: '', schema: { type: 'object' } });
        const parsed = JSON.parse(result);
        expect(parsed.error).toContain('non-empty string');
    });

    it('should return error for missing schema', async () => {
        const handler = handlers.get('json_extract');
        const result = await handler.execute({ text: 'some text', schema: null });
        const parsed = JSON.parse(result);
        expect(parsed.error).toContain('schema');
    });
});

// ═════════════════════════════════════════════════════════════════════
// json_transform
// ═════════════════════════════════════════════════════════════════════

describe('Structured Output — json_transform', () => {
    beforeEach(async () => {
        await loadSkill();
    });

    it('should return an LLM prompt with input and instructions', async () => {
        const handler = handlers.get('json_transform');
        const result = await handler.execute({
            input: { firstName: 'John', lastName: 'Doe' },
            instructions: 'Merge firstName and lastName into a single "fullName" field',
        });

        const parsed = JSON.parse(result);
        expect(parsed._action).toBe('llm_prompt');
        expect(parsed.prompt).toContain('firstName');
        expect(parsed.prompt).toContain('Merge firstName');
    });

    it('should include outputSchema when provided', async () => {
        const handler = handlers.get('json_transform');
        const outputSchema = { type: 'object', properties: { fullName: { type: 'string' } } };
        const result = await handler.execute({
            input: { first: 'A', last: 'B' },
            instructions: 'Combine first and last',
            outputSchema,
        });

        const parsed = JSON.parse(result);
        expect(parsed.prompt).toContain('OUTPUT SCHEMA');
        expect(parsed.outputSchema).toEqual(outputSchema);
    });

    it('should return error for null input', async () => {
        const handler = handlers.get('json_transform');
        const result = await handler.execute({ input: null, instructions: 'do something' });
        const parsed = JSON.parse(result);
        expect(parsed.error).toContain('input');
    });

    it('should return error for empty instructions', async () => {
        const handler = handlers.get('json_transform');
        const result = await handler.execute({ input: { a: 1 }, instructions: '' });
        const parsed = JSON.parse(result);
        expect(parsed.error).toContain('instructions');
    });
});

// ═════════════════════════════════════════════════════════════════════
// validate_json
// ═════════════════════════════════════════════════════════════════════

describe('Structured Output — validate_json', () => {
    beforeEach(async () => {
        await loadSkill();
    });

    it('should validate correct JSON against schema', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({
            data: JSON.stringify({ name: 'Alice', age: 25 }),
            schema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' },
                },
                required: ['name', 'age'],
            },
        });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(true);
        expect(parsed.data).toEqual({ name: 'Alice', age: 25 });
    });

    it('should report missing required fields', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({
            data: JSON.stringify({ name: 'Alice' }),
            schema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' },
                },
                required: ['name', 'age'],
            },
        });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(false);
        expect(parsed.errors.some((e: any) => e.message.includes('age'))).toBe(true);
    });

    it('should report type mismatches', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({
            data: JSON.stringify({ name: 123 }),
            schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
            },
        });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(false);
        expect(parsed.errors[0].message).toContain('Expected string');
    });

    it('should handle invalid JSON string', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({
            data: '{not valid json}',
            schema: { type: 'object' },
        });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(false);
        expect(parsed.errors[0].message).toContain('Invalid JSON');
    });

    it('should strip markdown fences from JSON', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({
            data: '```json\n{"name":"Bob"}\n```',
            schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
            },
        });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(true);
        expect(parsed.data.name).toBe('Bob');
    });

    it('should handle null data', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({ data: null, schema: { type: 'object' } });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(false);
    });

    it('should handle null schema', async () => {
        const handler = handlers.get('validate_json');
        const result = await handler.execute({ data: '{}', schema: null });

        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// Schema Validation Engine (direct unit tests)
// ═════════════════════════════════════════════════════════════════════

describe('Structured Output — validateAgainstSchema', () => {
    let validateAgainstSchema: typeof import('../src/skills/builtin/structured_output.js')['validateAgainstSchema'];

    beforeEach(async () => {
        const mod = await loadSkill();
        validateAgainstSchema = mod.validateAgainstSchema;
    });

    it('should validate nested object schemas', () => {
        const errors = validateAgainstSchema(
            { user: { name: 'Alice', address: { city: 'NYC' } } },
            {
                type: 'object',
                properties: {
                    user: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            address: {
                                type: 'object',
                                properties: { city: { type: 'string' } },
                                required: ['city'],
                            },
                        },
                        required: ['name', 'address'],
                    },
                },
                required: ['user'],
            },
        );
        expect(errors).toHaveLength(0);
    });

    it('should validate array items', () => {
        const errors = validateAgainstSchema(
            [1, 2, 'three'],
            {
                type: 'array',
                items: { type: 'number' },
            },
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].path).toContain('[2]');
    });

    it('should validate enum values', () => {
        const errors = validateAgainstSchema('red', { type: 'string', enum: ['green', 'blue'] });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('one of');
    });

    it('should validate string minLength/maxLength', () => {
        const errors = validateAgainstSchema('hi', { type: 'string', minLength: 5 });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('minimum');
    });

    it('should validate number minimum/maximum', () => {
        const errors = validateAgainstSchema(100, { type: 'number', maximum: 50 });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('maximum');
    });

    it('should validate string pattern', () => {
        const errors = validateAgainstSchema('abc', { type: 'string', pattern: '^\\d+$' });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('pattern');
    });

    it('should reject additional properties when additionalProperties is false', () => {
        const errors = validateAgainstSchema(
            { name: 'Alice', extra: true },
            {
                type: 'object',
                properties: { name: { type: 'string' } },
                additionalProperties: false,
            },
        );
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('extra');
    });

    it('should handle null value gracefully', () => {
        const errors = validateAgainstSchema(null, { type: 'string' });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('null');
    });

    it('should handle undefined value gracefully', () => {
        const errors = validateAgainstSchema(undefined, { type: 'string' });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('undefined');
    });

    it('should validate integer type (reject float)', () => {
        const errors = validateAgainstSchema(3.14, { type: 'integer' });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('integer');
    });

    it('should pass integer type for whole numbers', () => {
        const errors = validateAgainstSchema(42, { type: 'integer' });
        expect(errors).toHaveLength(0);
    });

    it('should validate empty array against schema', () => {
        const errors = validateAgainstSchema([], { type: 'array', items: { type: 'string' } });
        expect(errors).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// Prompt Builders (unit tests)
// ═════════════════════════════════════════════════════════════════════

describe('Structured Output — Prompt Builders', () => {
    let buildExtractionPrompt: typeof import('../src/skills/builtin/structured_output.js')['buildExtractionPrompt'];
    let buildTransformPrompt: typeof import('../src/skills/builtin/structured_output.js')['buildTransformPrompt'];
    let safeParseJSON: typeof import('../src/skills/builtin/structured_output.js')['safeParseJSON'];

    beforeEach(async () => {
        const mod = await loadSkill();
        buildExtractionPrompt = mod.buildExtractionPrompt;
        buildTransformPrompt = mod.buildTransformPrompt;
        safeParseJSON = mod.safeParseJSON;
    });

    it('buildExtractionPrompt should embed schema and text', () => {
        const prompt = buildExtractionPrompt('hello world', { type: 'object' });
        expect(prompt).toContain('hello world');
        expect(prompt).toContain('"type": "object"');
        expect(prompt).toContain('SCHEMA');
        expect(prompt).toContain('TEXT');
    });

    it('buildTransformPrompt should embed input and instructions', () => {
        const prompt = buildTransformPrompt({ a: 1 }, 'rename a to b');
        expect(prompt).toContain('"a": 1');
        expect(prompt).toContain('rename a to b');
    });

    it('buildTransformPrompt should include output schema when provided', () => {
        const prompt = buildTransformPrompt({ a: 1 }, 'rename', { type: 'object' });
        expect(prompt).toContain('OUTPUT SCHEMA');
    });

    it('safeParseJSON should parse valid JSON', () => {
        const result = safeParseJSON('{"key":"value"}');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data).toEqual({ key: 'value' });
    });

    it('safeParseJSON should strip markdown fences', () => {
        const result = safeParseJSON('```json\n{"a":1}\n```');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data).toEqual({ a: 1 });
    });

    it('safeParseJSON should return error for invalid JSON', () => {
        const result = safeParseJSON('{nope}');
        expect(result.ok).toBe(false);
    });
});
