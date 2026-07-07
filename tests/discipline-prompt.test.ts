/**
 * Discipline prompt (Organs 4+6) tests — the pure complexity + build helpers.
 */
import { describe, it, expect } from 'vitest';
import { looksComplex, buildDisciplinePrompt } from '../src/agent/disciplinePrompt.js';

describe('looksComplex', () => {
    it('trivial asks are not complex', () => {
        expect(looksComplex('hi')).toBe(false);
        expect(looksComplex('what time is it?')).toBe(false);
        expect(looksComplex('summarize this paragraph for me please today')).toBe(false);
    });
    it('multi-step / multi-file asks are complex', () => {
        expect(looksComplex('Refactor the auth module and then migrate the tests and update the docs.')).toBe(true);
        expect(looksComplex('1. add the endpoint\n2. wire the UI\n3. write tests')).toBe(true);
        expect(looksComplex('Build the widget, integrate the API, and deploy it to staging.')).toBe(true);
    });
});

describe('buildDisciplinePrompt', () => {
    it('empty when reliabilityMode is off', () => {
        expect(buildDisciplinePrompt('Refactor and migrate and deploy everything.', false)).toBe('');
    });
    it('always includes escalation discipline under reliabilityMode', () => {
        expect(buildDisciplinePrompt('hi', true)).toContain('escalate the irreversible');
    });
    it('adds plan-first only for complex tasks', () => {
        expect(buildDisciplinePrompt('hi', true)).not.toContain('plan first');
        expect(buildDisciplinePrompt('Refactor the module and then migrate the tests and update docs.', true)).toContain('plan first');
    });
    it('plan-first precedes escalation when both fire', () => {
        const p = buildDisciplinePrompt('Build the API, integrate the UI, and deploy to staging.', true);
        expect(p.indexOf('plan first')).toBeLessThan(p.indexOf('escalate the irreversible'));
    });
});
