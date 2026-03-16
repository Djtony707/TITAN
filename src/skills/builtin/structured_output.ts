/**
 * TITAN — Structured Output / JSON Mode Skill (Built-in)
 * Extract structured data from text, transform JSON shapes, and validate against schemas.
 * No external dependencies — uses the LLM itself for extraction and the built-in
 * schema validator for conformance checking.
 */
import { registerSkill } from '../registry.js';

// ─── Schema Validation Engine ───────────────────────────────────────

interface ValidationError {
    path: string;
    message: string;
}

interface SchemaNode {
    type?: string;
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    required?: string[];
    enum?: unknown[];
    description?: string;
    default?: unknown;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    additionalProperties?: boolean;
}

/**
 * Validate a value against a JSON Schema-like definition.
 * Supports: type, properties, required, items, enum, minimum, maximum,
 *           minLength, maxLength, pattern, additionalProperties.
 */
export function validateAgainstSchema(
    value: unknown,
    schema: SchemaNode,
    path: string = '$',
): ValidationError[] {
    const errors: ValidationError[] = [];

    // Null / undefined check
    if (value === null || value === undefined) {
        errors.push({ path, message: `Expected ${schema.type || 'value'}, got ${value === null ? 'null' : 'undefined'}` });
        return errors;
    }

    // Type check
    if (schema.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (schema.type === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                errors.push({ path, message: `Expected integer, got ${actualType}${typeof value === 'number' ? ` (${value})` : ''}` });
            }
        } else if (schema.type !== actualType) {
            errors.push({ path, message: `Expected ${schema.type}, got ${actualType}` });
            return errors; // No point checking further if type is wrong
        }
    }

    // Enum check
    if (schema.enum && !schema.enum.includes(value)) {
        errors.push({ path, message: `Value must be one of: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}` });
    }

    // String constraints
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push({ path, message: `String length ${value.length} is less than minimum ${schema.minLength}` });
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            errors.push({ path, message: `String length ${value.length} exceeds maximum ${schema.maxLength}` });
        }
        if (schema.pattern) {
            // Security: limit pattern length to mitigate ReDoS
            if (schema.pattern.length > 200) {
                errors.push({ path, message: 'Schema pattern exceeds maximum length (200 chars)' });
            } else {
                try {
                    const re = new RegExp(schema.pattern);
                    // Limit test input length to prevent catastrophic backtracking
                    const testValue = value.length > 10000 ? value.slice(0, 10000) : value;
                    if (!re.test(testValue)) {
                        errors.push({ path, message: `String does not match pattern: ${schema.pattern}` });
                    }
                } catch {
                    errors.push({ path, message: `Invalid pattern in schema: ${schema.pattern}` });
                }
            }
        }
    }

    // Number constraints
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push({ path, message: `Value ${value} is less than minimum ${schema.minimum}` });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push({ path, message: `Value ${value} exceeds maximum ${schema.maximum}` });
        }
    }

    // Object properties
    if (schema.type === 'object' && schema.properties && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;

        // Check required fields
        if (schema.required) {
            for (const key of schema.required) {
                if (!(key in obj)) {
                    errors.push({ path: `${path}.${key}`, message: `Missing required property: ${key}` });
                }
            }
        }

        // Validate each known property
        for (const [key, propSchema] of Object.entries(schema.properties)) {
            if (key in obj) {
                errors.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
            }
        }

        // Additional properties check
        if (schema.additionalProperties === false) {
            const allowedKeys = new Set(Object.keys(schema.properties));
            for (const key of Object.keys(obj)) {
                if (!allowedKeys.has(key)) {
                    errors.push({ path: `${path}.${key}`, message: `Unexpected additional property: ${key}` });
                }
            }
        }
    }

    // Array items
    if (schema.type === 'array' && schema.items && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            errors.push(...validateAgainstSchema(value[i], schema.items, `${path}[${i}]`));
        }
    }

    return errors;
}

/**
 * Build a prompt that instructs the LLM to extract structured JSON from text.
 */
export function buildExtractionPrompt(text: string, schema: Record<string, unknown>): string {
    return [
        'Extract structured data from the following text. Return ONLY valid JSON that conforms to the schema below — no markdown fences, no commentary.',
        '',
        '=== SCHEMA ===',
        JSON.stringify(schema, null, 2),
        '',
        '=== TEXT ===',
        text,
        '',
        '=== OUTPUT (JSON only) ===',
    ].join('\n');
}

/**
 * Build a prompt that instructs the LLM to transform JSON.
 */
export function buildTransformPrompt(
    input: unknown,
    instructions: string,
    outputSchema?: Record<string, unknown>,
): string {
    const parts = [
        'Transform the following JSON data according to the instructions. Return ONLY valid JSON — no markdown fences, no commentary.',
        '',
        '=== INPUT ===',
        JSON.stringify(input, null, 2),
        '',
        '=== INSTRUCTIONS ===',
        instructions,
    ];
    if (outputSchema) {
        parts.push('', '=== OUTPUT SCHEMA ===', JSON.stringify(outputSchema, null, 2));
    }
    parts.push('', '=== OUTPUT (JSON only) ===');
    return parts.join('\n');
}

/**
 * Attempt to parse JSON from a string, stripping markdown fences if present.
 */
export function safeParseJSON(raw: string): { ok: true; data: unknown } | { ok: false; error: string } {
    let cleaned = raw.trim();
    // Strip markdown code fences
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    try {
        return { ok: true, data: JSON.parse(cleaned) };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

// ─── Skill Registration ─────────────────────────────────────────────

export function registerStructuredOutputSkill(): void {
    // ── json_extract ────────────────────────────────────────────────
    registerSkill(
        {
            name: 'structured_output',
            description: 'Extract structured JSON data from unstructured text using a schema.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'json_extract',
            description:
                'Extract structured data from unstructured text using a JSON schema. ' +
                'Use when asked to "extract fields from this text", "parse this into JSON", ' +
                '"pull out the name/email/phone from this", or "convert this paragraph to structured data". ' +
                'Returns the extraction prompt for the LLM to fill, then validates the result against the schema.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'The unstructured text to extract data from',
                    },
                    schema: {
                        type: 'object',
                        description: 'JSON Schema describing the expected output shape (supports type, properties, required, items, enum)',
                    },
                    strict: {
                        type: 'boolean',
                        description: 'If true, fail when output does not match schema (default: false — returns best-effort result with warnings)',
                    },
                },
                required: ['text', 'schema'],
            },
            execute: async (args) => {
                try {
                    const text = args.text as string;
                    const schema = args.schema as Record<string, unknown>;
                    const strict = (args.strict as boolean) ?? false;

                    if (!text || typeof text !== 'string') {
                        return JSON.stringify({ error: 'Parameter "text" must be a non-empty string' });
                    }
                    if (!schema || typeof schema !== 'object') {
                        return JSON.stringify({ error: 'Parameter "schema" must be a JSON Schema object' });
                    }

                    // Build the extraction prompt — the LLM calling this tool should use
                    // the prompt to produce the JSON, then the tool validates.
                    const prompt = buildExtractionPrompt(text, schema);

                    // Since we cannot invoke the LLM from inside a tool, we return the
                    // prompt and instruct the agent to use it.
                    return JSON.stringify({
                        _action: 'llm_prompt',
                        prompt,
                        schema,
                        strict,
                        instructions: 'Use the prompt above to generate JSON. Then call validate_json with the result and the schema to verify conformance.',
                    }, null, 2);
                } catch (e) {
                    return JSON.stringify({ error: `json_extract failed: ${(e as Error).message}` });
                }
            },
        },
    );

    // ── json_transform ──────────────────────────────────────────────
    registerSkill(
        {
            name: 'structured_output',
            description: 'Transform JSON data from one shape to another.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'json_transform',
            description:
                'Transform JSON data from one shape to another using natural-language instructions. ' +
                'Use when asked to "reshape this JSON", "convert this object to a different format", ' +
                '"flatten this nested data", "rename these fields", or "map this array to a new structure". ' +
                'Returns the transformation prompt for the LLM to fill.',
            parameters: {
                type: 'object',
                properties: {
                    input: {
                        type: 'object',
                        description: 'The JSON data to transform (object or array)',
                    },
                    instructions: {
                        type: 'string',
                        description: 'Natural-language description of the desired transformation',
                    },
                    outputSchema: {
                        type: 'object',
                        description: 'Optional JSON Schema for the expected output shape',
                    },
                },
                required: ['input', 'instructions'],
            },
            execute: async (args) => {
                try {
                    const input = args.input;
                    const instructions = args.instructions as string;
                    const outputSchema = args.outputSchema as Record<string, unknown> | undefined;

                    if (input === undefined || input === null) {
                        return JSON.stringify({ error: 'Parameter "input" is required' });
                    }
                    if (!instructions || typeof instructions !== 'string') {
                        return JSON.stringify({ error: 'Parameter "instructions" must be a non-empty string' });
                    }

                    const prompt = buildTransformPrompt(input, instructions, outputSchema);

                    return JSON.stringify({
                        _action: 'llm_prompt',
                        prompt,
                        outputSchema: outputSchema || null,
                        instructions: 'Use the prompt above to produce transformed JSON. If an outputSchema is provided, call validate_json to verify the result.',
                    }, null, 2);
                } catch (e) {
                    return JSON.stringify({ error: `json_transform failed: ${(e as Error).message}` });
                }
            },
        },
    );

    // ── validate_json ───────────────────────────────────────────────
    registerSkill(
        {
            name: 'structured_output',
            description: 'Validate JSON data against a schema and report errors.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'validate_json',
            description:
                'Validate JSON against a JSON Schema and return a list of errors (if any). ' +
                'Use when asked to "check if this JSON is valid", "validate this payload", ' +
                '"does this match the schema?", or after json_extract / json_transform to verify output.',
            parameters: {
                type: 'object',
                properties: {
                    data: {
                        type: 'string',
                        description: 'The JSON string to validate (will be parsed)',
                    },
                    schema: {
                        type: 'object',
                        description: 'JSON Schema to validate against',
                    },
                },
                required: ['data', 'schema'],
            },
            execute: async (args) => {
                try {
                    const rawData = args.data as string;
                    const schema = args.schema as SchemaNode;

                    if (rawData === undefined || rawData === null) {
                        return JSON.stringify({ valid: false, errors: [{ path: '$', message: 'No data provided' }] });
                    }
                    if (!schema || typeof schema !== 'object') {
                        return JSON.stringify({ valid: false, errors: [{ path: '$', message: 'No schema provided' }] });
                    }

                    // Parse the data
                    const parsed = safeParseJSON(typeof rawData === 'string' ? rawData : JSON.stringify(rawData));
                    if (!parsed.ok) {
                        return JSON.stringify({
                            valid: false,
                            errors: [{ path: '$', message: `Invalid JSON: ${parsed.error}` }],
                        });
                    }

                    // Validate
                    const errors = validateAgainstSchema(parsed.data, schema);

                    if (errors.length === 0) {
                        return JSON.stringify({ valid: true, data: parsed.data });
                    }

                    return JSON.stringify({ valid: false, errors, data: parsed.data });
                } catch (e) {
                    return JSON.stringify({ valid: false, errors: [{ path: '$', message: `Validation failed: ${(e as Error).message}` }] });
                }
            },
        },
    );
}
