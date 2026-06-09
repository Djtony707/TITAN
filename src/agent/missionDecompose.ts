/**
 * Mission decomposition parsing.
 *
 * Turns the raw LLM response from the mission-decomposer sub-agent into the
 * `{ title, description, dependsOn? }` subtask shape `createGoal` expects.
 *
 * Pulled out of the gateway handler so the (fiddly) JSON extraction + the
 * dependency-edge mapping are pure and unit-testable. The mapping is the part
 * that matters for the visual workflow builder: the model emits dependsOn as
 * 1-based positions, and we map them to the `st-<n>` ids createGoal assigns —
 * keeping ONLY valid backward edges so the result is always an acyclic DAG.
 */

export interface DecomposedSubtask {
    title: string;
    description: string;
    dependsOn?: string[];
}

interface RawSubtask {
    title?: unknown;
    description?: unknown;
    dependsOn?: Array<number | string>;
}

const MAX_SUBTASKS = 6;
const TITLE_CAP = 80;
const DESC_CAP = 280;

/**
 * Map a model-provided dependsOn list (1-based positions, or "st-N"/"N"
 * strings) to `st-<n>` ids, keeping only BACKWARD references (a subtask may
 * only depend on an EARLIER one). Dedupes and drops anything out of range.
 *
 * @param raw      the dependsOn value the model emitted for this subtask
 * @param index    0-based index of the current subtask
 * @param total    total number of (cleaned) subtasks
 */
export function mapDependsOn(raw: unknown, index: number, total: number): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const deps = Array.from(
        new Set(
            raw
                .map(d => (typeof d === 'number' ? d : parseInt(String(d).replace(/^st-/i, ''), 10)))
                .filter(n => Number.isInteger(n) && n >= 1 && n < index + 1 && n <= total)
                .map(n => `st-${n}`),
        ),
    );
    return deps.length ? deps : undefined;
}

/**
 * Extract the first JSON object from raw LLM text (tolerating prose/markdown
 * around it) and normalize its `subtasks` into the createGoal shape. Returns
 * `undefined` when no usable subtasks can be parsed (caller then creates a
 * goal with no subtasks).
 */
export function parseMissionSubtasks(rawText: string): DecomposedSubtask[] | undefined {
    const raw = (rawText || '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return undefined;

    let parsed: { subtasks?: RawSubtask[] };
    try {
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { subtasks?: RawSubtask[] };
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length < 1) return undefined;

    const clean = parsed.subtasks
        .filter(s => typeof s?.title === 'string' && typeof s?.description === 'string')
        .slice(0, MAX_SUBTASKS);
    if (clean.length < 1) return undefined;

    return clean.map((s, i) => ({
        title: String(s.title).slice(0, TITLE_CAP),
        description: String(s.description).slice(0, DESC_CAP),
        dependsOn: mapDependsOn(s.dependsOn, i, clean.length),
    }));
}
