/**
 * TITAN — Auto-Verify
 * Automatically verifies tool results after write operations.
 * Catches truncated files, broken syntax, and incomplete outputs.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import logger from '../utils/logger.js';

const COMPONENT = 'AutoVerify';

export interface VerifyResult {
    passed: boolean;
    issue?: string;
    suggestion?: string;
}

/**
 * Verify a file after a write/append operation.
 * Returns pass/fail with optional fix suggestion.
 */
export function verifyFileWrite(toolName: string, args: Record<string, unknown>, toolResult: string): VerifyResult {
    // Only verify write_file and append_file
    if (toolName !== 'write_file' && toolName !== 'append_file') {
        return { passed: true };
    }

    const filePath = args.path as string;
    if (!filePath) return { passed: true };

    const resolved = resolve(filePath);

    // Check file exists
    if (!existsSync(resolved)) {
        return {
            passed: false,
            issue: `File ${filePath} does not exist after write`,
            suggestion: `The write_file call may have failed silently. Try calling write_file again.`,
        };
    }

    // Check file is not empty
    const stat = statSync(resolved);
    if (stat.size === 0) {
        return {
            passed: false,
            issue: `File ${filePath} is empty (0 bytes) after write`,
            suggestion: `The file was created but no content was written. Call write_file again with the content.`,
        };
    }

    // For HTML files, check structural completeness
    if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
        try {
            const content = readFileSync(resolved, 'utf-8');
            if (content.includes('<html') && !content.includes('</html>')) {
                return {
                    passed: false,
                    issue: `HTML file ${filePath} is truncated — has <html> but no </html>`,
                    suggestion: `The file is incomplete. Use append_file to add the missing closing sections (</main>, </body>, </html>) and any remaining content.`,
                };
            }
            if (content.includes('<body') && !content.includes('</body>')) {
                return {
                    passed: false,
                    issue: `HTML file ${filePath} is truncated — has <body> but no </body>`,
                    suggestion: `The file is incomplete. Use append_file to add the remaining body content and closing tags.`,
                };
            }
            if (content.includes('<script') && !content.includes('</script>')) {
                return {
                    passed: false,
                    issue: `HTML file ${filePath} has unclosed <script> tag`,
                    suggestion: `The JavaScript section is incomplete. Use append_file to complete the script and add </script></body></html>.`,
                };
            }
        } catch { /* can't read, skip */ }
    }

    // For JSON files, check valid JSON
    if (filePath.endsWith('.json')) {
        try {
            const content = readFileSync(resolved, 'utf-8');
            JSON.parse(content);
        } catch {
            return {
                passed: false,
                issue: `JSON file ${filePath} contains invalid JSON`,
                suggestion: `The JSON is malformed. Read the file and fix the syntax error.`,
            };
        }
    }

    // Check reasonable file size (warn if suspiciously small for written content)
    const writtenContent = args.content as string;
    if (writtenContent && stat.size < writtenContent.length * 0.5) {
        logger.warn(COMPONENT, `File ${filePath} is smaller than expected: ${stat.size} bytes vs ${writtenContent.length} written`);
    }

    logger.info(COMPONENT, `Verified ${filePath}: ${stat.size} bytes, OK`);
    return { passed: true };
}
