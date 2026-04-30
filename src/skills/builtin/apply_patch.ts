/**
 * TITAN — Apply Patch Skill (Built-in)
 * Apply unified diff patches to files. Matches OpenClaw's apply_patch tool.
 */
import { registerSkill } from '../registry.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { mkdirIfNotExists } from '../../utils/helpers.js';

export function registerApplyPatchSkill(): void {
    registerSkill(
        { name: 'apply_patch', description: 'Apply unified diff patches to files. USE THIS WHEN Tony says: "apply this patch", "apply the diff", "patch these files", or when editing code via unified diff format.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'apply_patch',
            description: 'Applies a unified diff patch to one or more files. USE THIS WHEN Tony says: "apply this patch", "apply the diff", "patch these files", "here\'s a unified diff, apply it". Used internally when editing code via unified diff format (like git diff output). Creates new files if they don\'t exist. RULES: Patch must be in unified diff format. Provide cwd if using relative paths.',
            parameters: {
                type: 'object',
                properties: {
                    patch: { type: 'string', description: 'Unified diff patch content' },
                    cwd: { type: 'string', description: 'Working directory for relative paths' },
                },
                required: ['patch'],
            },
            execute: async (args) => {
                const patch = args.patch as string;
                const cwd = (args.cwd as string) || process.cwd();
                const results: string[] = [];

                // Parse the unified diff
                const filePatches = patch.split(/^diff --git/m).filter(Boolean);

                if (filePatches.length === 0) {
                    // Try simple --- / +++ format
                    return applySimplePatch(patch, cwd);
                }

                for (const filePatch of filePatches) {
                    try {
                        // Extract file path from --- or +++ lines
                        const oldFile = filePatch.match(/^--- a\/(.+)$/m)?.[1];
                        const newFile = filePatch.match(/^\+\+\+ b\/(.+)$/m)?.[1];
                        const targetFile = newFile || oldFile;

                        if (!targetFile) {
                            results.push(`⚠️ Could not determine target file`);
                            continue;
                        }

                        const fullPath = targetFile.startsWith('/') ? targetFile : `${cwd}/${targetFile}`;
                        const isNewFile = oldFile === '/dev/null' || !existsSync(fullPath);

                        if (isNewFile) {
                            // Extract added lines
                            const addedLines = filePatch
                                .split('\n')
                                .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
                                .map((l) => l.slice(1))
                                .join('\n');

                            mkdirIfNotExists(dirname(fullPath));
                            writeFileSync(fullPath, addedLines, 'utf-8');
                            results.push(`✅ Created: ${targetFile}`);
                        } else {
                            // Apply hunks
                            let content = readFileSync(fullPath, 'utf-8');
                            const hunks = filePatch.match(/@@ .+ @@[\s\S]*?(?=@@ |$)/g) || [];

                            for (const hunk of hunks) {
                                const lines = hunk.split('\n').slice(1); // Skip @@ header
                                const removeLines = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
                                const addLines = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));

                                // Find and replace the removed lines with added lines
                                for (const removeLine of removeLines) {
                                    if (removeLine.trim()) {
                                        content = content.replace(removeLine, '');
                                    }
                                }
                                // Add new lines at approximately the right location
                                if (addLines.length > 0) {
                                    const contextLine = lines.find((l) => !l.startsWith('+') && !l.startsWith('-'))?.trim();
                                    if (contextLine) {
                                        const idx = content.indexOf(contextLine);
                                        if (idx >= 0) {
                                            content = content.slice(0, idx) + addLines.join('\n') + '\n' + content.slice(idx);
                                        } else {
                                            content += '\n' + addLines.join('\n');
                                        }
                                    } else {
                                        content += '\n' + addLines.join('\n');
                                    }
                                }
                            }

                            writeFileSync(fullPath, content, 'utf-8');
                            results.push(`✅ Patched: ${targetFile} (${hunks.length} hunk(s))`);
                        }
                    } catch (error) {
                        results.push(`❌ Error: ${(error as Error).message}`);
                    }
                }

                return results.join('\n') || 'No changes applied.';
            },
        },
    );
}

/** Apply a simple patch without git diff headers */
function applySimplePatch(patch: string, cwd: string): string {
    const newFileMatch = patch.match(/^\+\+\+ (.+)$/m);

    if (!newFileMatch) return 'Could not parse patch: no +++ line found.';

    let targetPath = newFileMatch[1].replace(/^b\//, '');
    if (!targetPath.startsWith('/')) targetPath = `${cwd}/${targetPath}`;

    const addedLines = patch
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .map((l) => l.slice(1));

    const removedLines = patch
        .split('\n')
        .filter((l) => l.startsWith('-') && !l.startsWith('---'))
        .map((l) => l.slice(1));

    if (existsSync(targetPath)) {
        let content = readFileSync(targetPath, 'utf-8');
        for (const line of removedLines) {
            content = content.replace(line + '\n', '');
        }
        if (addedLines.length > 0) {
            content += addedLines.join('\n') + '\n';
        }
        writeFileSync(targetPath, content, 'utf-8');
        return `✅ Patched: ${targetPath}`;
    } else {
        mkdirIfNotExists(dirname(targetPath));
        writeFileSync(targetPath, addedLines.join('\n') + '\n', 'utf-8');
        return `✅ Created: ${targetPath}`;
    }
}
