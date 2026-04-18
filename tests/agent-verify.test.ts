/**
 * Regression tests for verifyTaskCompletion (src/agent/agent.ts).
 *
 * The function gates the "Ralph Loop" — an outer re-run that injects a
 * "[TASK INCOMPLETE] you have file content from your previous read_file
 * call" prompt when it thinks the user asked for an edit and no write
 * tool was called. Before v4.3.4 the trigger was too broad and fired on
 * conversational voice notes like "fix your voice" — producing replies
 * like "I don't have a pending file edit task" because the model was
 * being told to edit a file that was never read.
 *
 * Don't reintroduce the regression: keep the verifier asking the
 * questions below.
 */
import { describe, it, expect } from 'vitest';
import { verifyTaskCompletion } from '../src/agent/agent.js';

describe('verifyTaskCompletion — false positives the v4.3.4 fix eliminated', () => {
    it('does NOT fire on "fix your voice" (conversational)', () => {
        const result = verifyTaskCompletion(
            'Figure out a way to fix your voice and make it calm and smooth. I will give you full permission to edit your files.',
            ['shell'],
            'response text',
        );
        expect(result.complete).toBe(true);
    });

    it('does NOT fire when the only tool was shell (ls / pwd / ps)', () => {
        const result = verifyTaskCompletion(
            'edit the config', // vague — no file path
            ['shell'],
            'response',
        );
        expect(result.complete).toBe(true);
    });

    it('does NOT fire on "update the page" with no file reference', () => {
        const result = verifyTaskCompletion(
            'update the dashboard please',
            ['shell'],
            'ok',
        );
        expect(result.complete).toBe(true);
    });

    it('does NOT fire when user says "files" but no specific file', () => {
        const result = verifyTaskCompletion(
            'fix the files',
            ['read_file'],
            'ok',
        );
        expect(result.complete).toBe(true);
    });
});

describe('verifyTaskCompletion — true positives still fire', () => {
    it('fires when user names a .ts file + read_file was called + no write', () => {
        const result = verifyTaskCompletion(
            'edit src/channels/messenger.ts to bump the timeout',
            ['read_file'],
            'response',
        );
        expect(result.complete).toBe(false);
        expect(result.reason).toMatch(/did not save/i);
    });

    it('fires when user names a .json file + read_file was called + no write', () => {
        const result = verifyTaskCompletion(
            'update /home/dj/.titan/titan.json to set port to 9000',
            ['read_file'],
            'response',
        );
        expect(result.complete).toBe(false);
    });

    it('does NOT fire when the write actually happened', () => {
        const result = verifyTaskCompletion(
            'edit src/foo.ts to bump the timeout',
            ['read_file', 'edit_file'],
            'done',
        );
        expect(result.complete).toBe(true);
    });

    it('does NOT fire when read_file was NEVER called (verifier requires a read)', () => {
        const result = verifyTaskCompletion(
            'edit src/foo.ts to bump the timeout',
            [], // no tools at all
            'response',
        );
        expect(result.complete).toBe(true);
    });
});

describe('verifyTaskCompletion — "asked to run" path still works', () => {
    it('fires when user says "run the command" and no shell was called', () => {
        const result = verifyTaskCompletion(
            'run the command',
            ['read_file'],
            'response',
        );
        expect(result.complete).toBe(false);
        expect(result.reason).toMatch(/shell/i);
    });

    it('does NOT fire when shell was called', () => {
        const result = verifyTaskCompletion(
            'run the script',
            ['shell'],
            'done',
        );
        expect(result.complete).toBe(true);
    });
});
