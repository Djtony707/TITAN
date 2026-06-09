/**
 * TITAN — system-widget shortcut detector (v7.0 model-agnostic widget gate).
 * These directly cover the eval cases that failed (widget-creation/gate-format)
 * and the anti-hijack guards that keep real tasks from triggering a widget.
 */
import { describe, it, expect } from 'vitest';
import { detectSystemWidget, buildSystemWidgetGate } from '../src/agent/systemWidgets.js';

describe('detectSystemWidget — shortcuts that MUST match (the failing eval cases)', () => {
    it('"show backup" → system:backup', () => {
        expect(detectSystemWidget('show backup')?.source).toBe('system:backup');
    });
    it('"show recipes" → system:recipes', () => {
        expect(detectSystemWidget('show recipes')?.source).toBe('system:recipes');
    });
    it('"show training dashboard" → system:training (widget-noun path)', () => {
        expect(detectSystemWidget('show training dashboard')?.source).toBe('system:training');
    });
    it('other short display shortcuts match', () => {
        expect(detectSystemWidget('open vram')?.source).toBe('system:vram');
        expect(detectSystemWidget('show cron')?.source).toBe('system:cron');
        expect(detectSystemWidget('pull up the fleet router')?.source).toBe('system:fleet');
    });
});

describe('detectSystemWidget — anti-hijack (must NOT match real tasks)', () => {
    it('file / read / code requests', () => {
        expect(detectSystemWidget('show me the backup file contents')).toBeNull();
        expect(detectSystemWidget('open backup.ts')).toBeNull();
        expect(detectSystemWidget('read the training logs')).toBeNull();
    });
    it('long task sentences without a widget-noun', () => {
        expect(detectSystemWidget('show me how to back up the database to S3 with a cron job tonight')).toBeNull();
    });
    it('action verbs (not display) on short commands', () => {
        expect(detectSystemWidget('create a backup')).toBeNull();
        expect(detectSystemWidget('run the backup')).toBeNull();
        expect(detectSystemWidget('delete old snapshots')).toBeNull();
    });
    it('no imperative / statements', () => {
        expect(detectSystemWidget('what is the weather')).toBeNull();
        expect(detectSystemWidget('the backup completed successfully')).toBeNull();
        expect(detectSystemWidget('')).toBeNull();
    });
});

describe('buildSystemWidgetGate', () => {
    it('produces a valid _____widget gate (parseable JSON, system format)', () => {
        const gate = buildSystemWidgetGate({ source: 'system:backup', name: 'Backup Manager' });
        expect(gate).toContain('_____widget');
        expect(gate).toContain('"format": "system"');
        expect(gate).toContain('"source": "system:backup"');
        const json = gate.slice(gate.indexOf('{'));
        expect(() => JSON.parse(json)).not.toThrow();
        expect(JSON.parse(json)).toMatchObject({ source: 'system:backup', format: 'system', name: 'Backup Manager' });
    });
});
