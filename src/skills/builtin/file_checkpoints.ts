/**
 * TITAN — File Checkpoint Tools
 *
 * Exposes shadow git checkpoints as agent tools for file recovery.
 * Tools: checkpoint_list, checkpoint_diff, checkpoint_restore
 */
import { registerSkill } from '../registry.js';
import { listCheckpoints, diffCheckpoint, restoreCheckpoint } from '../../agent/shadowGit.js';

export function registerFileCheckpointsSkill(): void {
    registerSkill(
        {
            name: 'file_checkpoints',
            description: 'File checkpoint management — list, diff, and restore file snapshots',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'checkpoint_list',
            description: 'List file checkpoints (automatic snapshots taken before write/edit operations).\nUSE THIS WHEN: user asks about file history, wants to see what changed, or needs to recover a previous version.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File or directory path to list checkpoints for',
                    },
                },
                required: ['path'],
            },
            execute: async (args) => {
                const path = args.path as string;
                const checkpoints = listCheckpoints(path);

                if (checkpoints.length === 0) {
                    return `No checkpoints found for ${path}. Checkpoints are created automatically before file write/edit operations.`;
                }

                const lines = checkpoints.map(c =>
                    `[${c.id}] ${c.timestamp} — ${c.toolName} on ${c.filePath}`,
                );
                return `${checkpoints.length} checkpoint(s) found:\n${lines.join('\n')}`;
            },
        },
    );

    registerSkill(
        {
            name: 'file_checkpoints',
            description: 'File checkpoint diff',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'checkpoint_diff',
            description: 'Show the diff between a checkpoint and the current file state.\nUSE THIS WHEN: user wants to see what changed since a specific point in time.',
            parameters: {
                type: 'object',
                properties: {
                    checkpoint_id: {
                        type: 'string',
                        description: 'Checkpoint ID (from checkpoint_list output)',
                    },
                },
                required: ['checkpoint_id'],
            },
            execute: async (args) => {
                const id = args.checkpoint_id as string;
                return diffCheckpoint(id);
            },
        },
    );

    registerSkill(
        {
            name: 'file_checkpoints',
            description: 'File checkpoint restore',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'checkpoint_restore',
            description: 'Restore a file to its state at a specific checkpoint.\nUSE THIS WHEN: user wants to undo changes, recover a previous version, or revert a file.',
            parameters: {
                type: 'object',
                properties: {
                    checkpoint_id: {
                        type: 'string',
                        description: 'Checkpoint ID to restore from (from checkpoint_list output)',
                    },
                },
                required: ['checkpoint_id'],
            },
            execute: async (args) => {
                const id = args.checkpoint_id as string;
                return restoreCheckpoint(id);
            },
        },
    );
}
