import { describe, it, expect } from 'vitest';
import { parseMissionSubtasks, mapDependsOn } from '../src/agent/missionDecompose.js';

describe('mapDependsOn', () => {
    it('maps 1-based numeric positions to st-<n> ids', () => {
        expect(mapDependsOn([1, 2], 2, 4)).toEqual(['st-1', 'st-2']);
    });

    it('keeps only BACKWARD edges (drops self + forward refs)', () => {
        // current subtask is index 1 (the 2nd, st-2); only st-1 is valid
        expect(mapDependsOn([1, 2, 3], 1, 4)).toEqual(['st-1']);
    });

    it('drops out-of-range positions', () => {
        expect(mapDependsOn([0, 9, 2], 3, 4)).toEqual(['st-2']);
    });

    it('parses string forms "st-N" and "N"', () => {
        expect(mapDependsOn(['st-1', '2'], 3, 4)).toEqual(['st-1', 'st-2']);
    });

    it('dedupes repeated references', () => {
        expect(mapDependsOn([1, 1, '1', 'st-1'], 2, 4)).toEqual(['st-1']);
    });

    it('returns undefined for non-arrays, empty, and all-invalid', () => {
        expect(mapDependsOn(undefined, 1, 3)).toBeUndefined();
        expect(mapDependsOn([], 1, 3)).toBeUndefined();
        expect(mapDependsOn('1,2', 1, 3)).toBeUndefined();
        expect(mapDependsOn([5, 6], 1, 3)).toBeUndefined(); // all forward/out-of-range
    });
});

describe('parseMissionSubtasks', () => {
    it('parses clean JSON and threads dependency edges', () => {
        const raw = JSON.stringify({
            subtasks: [
                { title: 'Research frameworks', description: 'find top 3', dependsOn: [] },
                { title: 'Gather details', description: 'pull specs', dependsOn: [1] },
                { title: 'Draft comparison', description: 'one paragraph', dependsOn: [1, 2] },
                { title: 'Save to file', description: 'write md', dependsOn: [3] },
            ],
        });
        const out = parseMissionSubtasks(raw);
        expect(out).toHaveLength(4);
        expect(out![0].dependsOn).toBeUndefined();
        expect(out![1].dependsOn).toEqual(['st-1']);
        expect(out![2].dependsOn).toEqual(['st-1', 'st-2']);
        expect(out![3].dependsOn).toEqual(['st-3']);
    });

    it('extracts JSON embedded in prose / markdown fences', () => {
        const raw = 'Sure! Here is the plan:\n```json\n{"subtasks":[{"title":"A","description":"do a"},{"title":"B","description":"do b","dependsOn":[1]}]}\n```\nHope that helps.';
        const out = parseMissionSubtasks(raw);
        expect(out).toHaveLength(2);
        expect(out![1].dependsOn).toEqual(['st-1']);
    });

    it('omits dependsOn entirely when the model provides none (flat DAG is honest)', () => {
        const raw = JSON.stringify({ subtasks: [
            { title: 'A', description: 'a' },
            { title: 'B', description: 'b' },
        ] });
        const out = parseMissionSubtasks(raw);
        expect(out![0].dependsOn).toBeUndefined();
        expect(out![1].dependsOn).toBeUndefined();
    });

    it('drops forward/cyclic edges so the result is always acyclic', () => {
        const raw = JSON.stringify({ subtasks: [
            { title: 'A', description: 'a', dependsOn: [2] }, // forward → dropped
            { title: 'B', description: 'b', dependsOn: [1] },
        ] });
        const out = parseMissionSubtasks(raw);
        expect(out![0].dependsOn).toBeUndefined();
        expect(out![1].dependsOn).toEqual(['st-1']);
    });

    it('caps at 6 subtasks and filters entries missing title/description', () => {
        const raw = JSON.stringify({ subtasks: [
            { title: 'A', description: 'a' },
            { title: 'B' },                       // no description → filtered
            { description: 'c' },                 // no title → filtered
            ...Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, description: `d${i}` })),
        ] });
        const out = parseMissionSubtasks(raw);
        expect(out!.length).toBe(6);
    });

    it('caps title and description length', () => {
        const raw = JSON.stringify({ subtasks: [
            { title: 'x'.repeat(200), description: 'y'.repeat(500) },
        ] });
        const out = parseMissionSubtasks(raw);
        expect(out![0].title.length).toBe(80);
        expect(out![0].description.length).toBe(280);
    });

    it('returns undefined for non-JSON, malformed JSON, and missing subtasks', () => {
        expect(parseMissionSubtasks('no json here')).toBeUndefined();
        expect(parseMissionSubtasks('{ not valid json')).toBeUndefined();
        expect(parseMissionSubtasks('{"foo":"bar"}')).toBeUndefined();
        expect(parseMissionSubtasks('{"subtasks":[]}')).toBeUndefined();
        expect(parseMissionSubtasks('')).toBeUndefined();
    });
});
