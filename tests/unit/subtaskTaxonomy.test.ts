/**
 * TITAN — Unit Tests: subtaskTaxonomy
 *
 * Bug #1 regression: classifySubtask must recognize artifact-producing verbs
 * like "download" and "embed" so file-producing tasks don't get misclassified
 * as "analysis".
 */
import { describe, it, expect } from 'vitest';
import { classifySubtask, describeKind } from '../../src/agent/subtaskTaxonomy.js';

describe('classifySubtask', () => {
    it('classifies "download images and embed in essay" as code (not analysis)', () => {
        const result = classifySubtask({
            title: 'download the images and put them in the essay',
            description: 'Search for 5 high-resolution images and download them, then create an HTML file embedding them.',
        });
        expect(result).toBe('code');
    });

    it('classifies "download images for gallery" as code', () => {
        const result = classifySubtask({
            title: 'download images for the gallery',
            description: 'Use web_search and web_fetch to find and save images.',
        });
        expect(result).toBe('code');
    });

    it('classifies "embed analytics dashboard" as code', () => {
        const result = classifySubtask({
            title: 'embed analytics dashboard into the page',
            description: 'Create a React component that embeds the Chart.js dashboard.',
        });
        expect(result).toBe('code');
    });

    it('classifies "save the generated report" as code', () => {
        const result = classifySubtask({
            title: 'save the generated report to disk',
            description: 'Write the report as an HTML file to /tmp/report.html',
        });
        expect(result).toBe('code');
    });

    it('classifies "design safety metrics dashboard" as code', () => {
        const result = classifySubtask({
            title: 'Design safety metrics dashboard',
            description: 'Build a React component showing safety KPIs.',
        });
        expect(result).toBe('code');
    });

    it('classifies pure research as research', () => {
        const result = classifySubtask({
            title: 'Research competitor pricing',
            description: 'Find and compare pricing for 5 competitors.',
        });
        expect(result).toBe('research');
    });

    it('classifies pure analysis as analysis', () => {
        const result = classifySubtask({
            title: 'Analyze Q3 revenue trends',
            description: 'Interpret the CSV data and identify patterns.',
        });
        expect(result).toBe('analysis');
    });

    it('classifies document writing as write', () => {
        const result = classifySubtask({
            title: 'Write a project README',
            description: 'Document the setup and usage of the API.',
        });
        expect(result).toBe('write');
    });

    // v6.1.0-alpha.50 — regression: "Write a 3 page essay about MLK"
    // pre-alpha.50 returned 'analysis' (default) because the write-title
    // regex listed `report|spec|post|article|readme|summary|changelog`
    // but NOT `essay`. The empty description killed keyword-scoring.
    // Caught in the wild as misrouting MLK / moon-landing essay
    // missions to the Analyst specialist (no write_file tool).
    it('classifies "Write a 3 page essay about Martin Luther King" as write (alpha.50 fix)', () => {
        expect(classifySubtask({
            title: 'Write a 3 page essay about Martin Luther King',
            description: '',
        })).toBe('write');
    });

    it('classifies "Write a short 1-paragraph essay about the moon landing with one image" as write (alpha.50 fix)', () => {
        expect(classifySubtask({
            title: 'Write a short 1-paragraph essay about the moon landing with one image.',
            description: '',
        })).toBe('write');
    });

    it('classifies "Write a blog post on AI" as write', () => {
        expect(classifySubtask({
            title: 'Write a blog post on AI',
            description: '',
        })).toBe('write');
    });

    it('classifies "Write a long-form paper on climate" as write', () => {
        expect(classifySubtask({
            title: 'Write a long-form paper on climate',
            description: '',
        })).toBe('write');
    });

    it('classifies verify task as verify', () => {
        const result = classifySubtask({
            title: 'Verify all tests pass',
            description: 'Run the test suite and confirm all tests pass.',
        });
        expect(result).toBe('verify');
    });
});

describe('describeKind', () => {
    it('returns human-readable descriptions', () => {
        expect(describeKind('code')).toContain('write or edit files');
        expect(describeKind('research')).toContain('fact-finding');
        expect(describeKind('analysis')).toContain('interpret data');
    });
});
