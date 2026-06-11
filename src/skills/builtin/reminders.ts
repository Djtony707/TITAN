/**
 * Reminder skill — the tool models were hallucinating (v7.0).
 *
 * "Remind me Friday at 5pm to buy charcoal" now has a real, verifiable path:
 * action=set persists a reminder; a 60s daemon watcher fires it through the
 * heartbeat channel so the mascot says it (and any heartbeat consumer shows
 * it). The system prompt always carries the current local date+time, so the
 * model converts natural language ("Friday 5pm") to ISO itself.
 */
import { registerSkill } from '../registry.js';
import { addReminder, listReminders, cancelReminder } from '../../agent/reminders.js';

export function registerReminderSkill(): void {
    registerSkill(
        {
            name: 'reminder',
            description: 'Set, list, and cancel reminders that TITAN delivers to the user at a specific time.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'reminder',
            description: [
                'Set, list, or cancel personal reminders. TITAN delivers the reminder to the user at the right time (the mascot announces it on the desk).',
                '',
                'USE THIS when the user says: "remind me to X at/on Y", "don\'t let me forget X", "ping me Friday about X". This is the ONLY correct way to set a reminder — never claim a reminder is set without calling this.',
                'NOT for recurring jobs ("every morning", "daily at 9") → use the `cron` tool for those.',
                '',
                'ACTIONS:',
                '  • set    — message (what to say) + when (ISO 8601 datetime WITH timezone offset, e.g. "2026-06-12T17:00:00-07:00"). Convert the user\'s natural-language time to ISO using the current local date/time from your context.',
                '  • list   — pending reminders.',
                '  • cancel — id (from list), or "all" to clear pending.',
                '',
                'Returns the saved reminder with its exact local fire time — confirm THAT time back to the user.',
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['set', 'list', 'cancel'], description: 'What to do.' },
                    message: { type: 'string', description: 'set: what to remind the user about.' },
                    when: { type: 'string', description: 'set: ISO 8601 datetime with timezone offset.' },
                    id: { type: 'string', description: 'cancel: reminder id, or "all".' },
                },
                required: ['action'],
            },
            execute: async (args: Record<string, unknown>): Promise<string> => {
                const action = String(args.action ?? '');
                if (action === 'set') {
                    const result = addReminder(String(args.message ?? ''), String(args.when ?? ''));
                    if ('error' in result) return `Error: ${result.error}`;
                    const local = new Date(result.dueAt).toLocaleString();
                    return `Reminder set (id: ${result.id}): "${result.message}" — I'll tell you on ${local}.`;
                }
                if (action === 'list') {
                    const pending = listReminders();
                    if (pending.length === 0) return 'No pending reminders.';
                    return pending.map(r => `${r.id} — "${r.message}" at ${new Date(r.dueAt).toLocaleString()}`).join('\n');
                }
                if (action === 'cancel') {
                    const id = String(args.id ?? '');
                    if (!id) return 'Error: provide id (or "all").';
                    return cancelReminder(id) ? `Cancelled ${id}.` : `No pending reminder matched "${id}".`;
                }
                return 'Error: action must be set, list, or cancel.';
            },
        },
    );
}
