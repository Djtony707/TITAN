import { describe, it, expect } from 'vitest';
import { dueReminders, type Reminder } from '../src/agent/reminders.js';

const rem = (id: string, dueAt: string, firedAt?: string): Reminder =>
    ({ id, message: id, dueAt, createdAt: dueAt, firedAt });

describe('reminders — due logic (pure)', () => {
    const NOW = new Date('2026-06-12T17:00:00Z').getTime();

    it('fires reminders at/past their due time', () => {
        const all = [rem('a', '2026-06-12T16:59:00Z'), rem('b', '2026-06-12T17:00:00Z')];
        expect(dueReminders(all, NOW).map(r => r.id)).toEqual(['a', 'b']);
    });

    it('does not fire future reminders', () => {
        const all = [rem('c', '2026-06-12T17:01:00Z')];
        expect(dueReminders(all, NOW)).toEqual([]);
    });

    it('never re-fires already-fired reminders', () => {
        const all = [rem('d', '2026-06-12T16:00:00Z', '2026-06-12T16:00:30Z')];
        expect(dueReminders(all, NOW)).toEqual([]);
    });
});
