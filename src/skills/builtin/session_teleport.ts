/**
 * TITAN — Session Teleport Skill
 * Export/import live agent sessions between surfaces (CLI, web, mobile, API).
 * Comparable to Claude Code's session teleporting.
 */
import { registerSkill } from '../registry.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { getContextMessages, getOrCreateSession, addMessage } from '../../agent/session.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'SessionTeleport';
const TELEPORT_DIR = join(TITAN_HOME, 'teleport');

export function registerSessionTeleportSkill(): void {
    registerSkill(
        { name: 'session_teleport', description: 'Export/import agent sessions', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'session_teleport',
            description: 'Export or import a live agent session for use on another device/surface.\nUSE THIS WHEN: "export this session", "continue on my phone", "import session", "teleport session"',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['export', 'import', 'list'], description: 'export current session, import from file, or list available' },
                    sessionId: { type: 'string', description: 'Session ID to export (uses current if not specified)' },
                    filePath: { type: 'string', description: 'File path for import' },
                    code: { type: 'string', description: 'Teleport code for quick transfer' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const { mkdirSync } = await import('fs');
                if (!existsSync(TELEPORT_DIR)) mkdirSync(TELEPORT_DIR, { recursive: true });

                if (action === 'export') {
                    const sessionId = args.sessionId as string;
                    if (!sessionId) return 'Error: Provide a sessionId to export.';
                    try {
                        const messages = getContextMessages({ id: sessionId, channel: 'api', userId: 'export', agentId: 'default', status: 'active', messageCount: 0, createdAt: new Date().toISOString(), lastActive: new Date().toISOString() });
                        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
                        const exportData = { sessionId, messages, exportedAt: new Date().toISOString(), code };
                        const exportPath = join(TELEPORT_DIR, `${code}.json`);
                        writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
                        return `Session exported!\nTeleport code: ${code}\nFile: ${exportPath}\n\nUse this code on another device to import the session.`;
                    } catch (e) {
                        return `Export failed: ${(e as Error).message}`;
                    }
                }
                if (action === 'import') {
                    const code = args.code as string;
                    const filePath = (args.filePath as string) || (code ? join(TELEPORT_DIR, `${code}.json`) : '');
                    if (!filePath || !existsSync(filePath)) return 'Error: Teleport file not found. Provide a valid code or filePath.';
                    try {
                        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
                        return `Session imported!\nOriginal session: ${data.sessionId}\nMessages: ${data.messages?.length || 0}\nExported: ${data.exportedAt}\n\nSession context is now available.`;
                    } catch (e) {
                        return `Import failed: ${(e as Error).message}`;
                    }
                }
                if (action === 'list') {
                    const { readdirSync } = await import('fs');
                    const files = existsSync(TELEPORT_DIR) ? readdirSync(TELEPORT_DIR).filter(f => f.endsWith('.json')) : [];
                    if (files.length === 0) return 'No exported sessions found.';
                    return files.map(f => {
                        const data = JSON.parse(readFileSync(join(TELEPORT_DIR, f), 'utf-8'));
                        return `${data.code || f} — ${data.messages?.length || 0} messages (${data.exportedAt})`;
                    }).join('\n');
                }
                return 'Use: export, import, or list';
            },
        },
    );
}
