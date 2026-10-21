/**
 * Fixed file operations anchored to a policy-selected canonical root for one request.
 * Linux/macOS only; other platforms fail closed. This is not a general filesystem
 * or shell sandbox, and it does not pin configured root identities across requests.
 * Rename stays within one parent (not an atomic no-overwrite guarantee against other
 * writers); deletion permits regular files and empty directories, never recursion.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';
import type * as Fs from 'fs';

export interface FileOperation {
    operation: 'read' | 'write' | 'list' | 'mkdir' | 'delete' | 'rename';
    path: string;
    newPath?: string;
    dataBase64?: string;
}
interface Identity { dev: string; ino: string }
export interface FileOperationResult {
    ok: boolean;
    status?: number;
    error?: string;
    anchor?: Identity;
    size?: number;
    modified?: string;
    dataBase64?: string;
    truncated?: boolean;
    entries?: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }>;
}
interface WorkerRequest extends FileOperation { anchor: Identity }
interface WorkerRuntime { fs: typeof Fs; chdir: (path: string) => void; platform: string }

// This function is serialized into a fixed Node child. It must remain self-contained:
// no imported values, caller-supplied code, shells, inherited NODE_OPTIONS, or test flags.
export function confinedFileWorker(request: WorkerRequest, runtime?: WorkerRuntime): FileOperationResult {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const io: typeof Fs = runtime?.fs ?? require('node:fs');
    const chdir = runtime?.chdir ?? ((path: string) => process.chdir(path));
    const platform = runtime?.platform ?? process.platform;
    const denied = (message: string, status = 403): never => { throw Object.assign(new Error(message), { status }); };
    const identity = (stat: Fs.BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino) });
    const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
    const metadata = (stat: Fs.BigIntStats) => ({ size: Number(stat.size), modified: new Date(Number(stat.mtimeMs)).toISOString() });
    const components = (path: unknown): string[] => {
        if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return denied('Invalid relative file path', 400);
        if (!path) return [];
        const parts = path.split('/');
        if (parts.some(part => !part || part === '.' || part === '..')) denied('Invalid relative file path', 400);
        return parts;
    };
    const descend = (parts: string[], create = false) => {
        for (const part of parts) {
            let before: Fs.BigIntStats;
            try { before = io.lstatSync(part, { bigint: true }); }
            catch (error) {
                if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                io.mkdirSync(part, { mode: 0o700 });
                before = io.lstatSync(part, { bigint: true });
            }
            if (!before.isDirectory() || before.isSymbolicLink()) denied('Symlink or non-directory path component refused');
            chdir(part);
            const after = io.statSync('.', { bigint: true });
            if (!same(identity(before), identity(after))) denied('Directory changed during file access');
        }
    };
    let fd: number | undefined;
    try {
        if (platform !== 'linux' && platform !== 'darwin') denied('Anchored file access is unsupported on this platform');
        if (!request || !['read', 'write', 'list', 'mkdir', 'delete', 'rename'].includes(request.operation)) denied('Invalid file operation', 400);
        if (!io.constants.O_NOFOLLOW || !io.constants.O_NONBLOCK) denied('Required no-follow file access is unavailable');
        const root = io.statSync('.', { bigint: true });
        if (!root.isDirectory() || !request.anchor || !same(identity(root), request.anchor)) denied('Configured file root changed');
        const anchor = identity(root);
        const parts = components(request.path);
        // Validate before creating directories or files, including empty new files.
        let writeData: Buffer | undefined;
        if (request.operation === 'write') {
            if (typeof request.dataBase64 !== 'string' || request.dataBase64.length > 14 * 1024 * 1024) denied('File content too large', 413);
            writeData = Buffer.from(request.dataBase64!, 'base64');
            if (writeData.length > 10 * 1024 * 1024 || writeData.toString('base64') !== request.dataBase64) denied('Invalid or oversized file content', 413);
        }
        if (request.operation === 'list') {
            descend(parts);
            const entries: NonNullable<FileOperationResult['entries']> = [];
            const names = io.readdirSync('.');
            if (names.length > 10_000) denied('Directory has too many entries to list', 413);
            for (const name of names) {
                const stat = io.lstatSync(name, { bigint: true });
                if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
                entries.push({ name, type: stat.isDirectory() ? 'directory' : 'file', ...metadata(stat) });
            }
            return { ok: true, anchor, entries };
        }
        if (!parts.length) denied('An operation on the root itself is not allowed');
        const leaf = parts.pop()!;
        if (request.operation === 'rename') {
            const destination = components(request.newPath);
            const newLeaf = destination.pop();
            if (!newLeaf || destination.join('/') !== parts.join('/')) return denied('Cross-directory rename is unsupported by anchored file access');
            descend(parts);
            const before = io.lstatSync(leaf, { bigint: true });
            if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) denied('Unsafe rename source');
            try { io.lstatSync(newLeaf); denied('Destination already exists', 409); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            io.renameSync(leaf, newLeaf);
            return { ok: true, anchor };
        }
        descend(parts, request.operation === 'write' || request.operation === 'mkdir');
        if (request.operation === 'mkdir') {
            io.mkdirSync(leaf, { mode: 0o700 });
            return { ok: true, anchor };
        }
        let before: Fs.BigIntStats | undefined;
        try { before = io.lstatSync(leaf, { bigint: true }); }
        catch (error) { if (request.operation !== 'write' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (before?.isSymbolicLink()) denied('Symlink file access refused');
        if (request.operation === 'delete') {
            if (before?.isDirectory()) io.rmdirSync(leaf); // Empty directories only; never recursive.
            else if (before?.isFile()) io.unlinkSync(leaf);
            else denied('Not a regular file or directory');
            return { ok: true, anchor };
        }
        if (before && (!before.isFile() || before.nlink !== 1n)) denied('Not a single-link regular file');
        const flags = request.operation === 'read' ? io.constants.O_RDONLY
            : before ? io.constants.O_RDWR : io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL;
        fd = io.openSync(leaf, flags | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK, 0o600);
        const opened = io.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || (before && !same(identity(opened), identity(before)))) denied('File changed during access or has multiple links');
        if (request.operation === 'write') {
            const data = writeData!;
            io.ftruncateSync(fd, 0);
            let written = 0;
            while (written < data.length) written += io.writeSync(fd, data, written, data.length - written);
            return { ok: true, anchor, ...metadata(io.fstatSync(fd, { bigint: true })) };
        }
        const data = Buffer.alloc(Math.min(Number(opened.size), 1024 * 1024));
        let count = 0;
        while (count < data.length) {
            const read = io.readSync(fd, data, count, data.length - count, count);
            if (!read) break;
            count += read;
        }
        return { ok: true, anchor, ...metadata(opened), dataBase64: data.subarray(0, count).toString('base64'), truncated: Number(opened.size) > data.length };
    } catch (error) {
        const problem = error as NodeJS.ErrnoException & { status?: number };
        const status = problem.status ?? (problem.code === 'ENOENT' ? 404 : problem.code === 'EEXIST' ? 409 : ['ELOOP', 'ENOTDIR'].includes(problem.code ?? '') ? 403 : problem.code === 'ENOTEMPTY' ? 400 : 500);
        return { ok: false, status, error: problem.status ? problem.message : status === 404 ? 'File path not found' : status === 409 ? 'Path already exists' : status === 400 ? 'Directory not empty' : status === 403 ? 'Unsafe file path refused' : 'File operation failed' };
    } finally {
        if (fd !== undefined) io.closeSync(fd);
    }
}

export function runConfinedFileOperation(rootPath: string, operation: FileOperation): FileOperationResult {
    try {
        // Policy selects a trusted root pathname for each request. Its canonical location
        // (including deliberate aliases such as macOS /tmp) is trusted, then its inode is
        // pinned for this operation only. This does not pin a configured root for life.
        const root = fs.realpathSync(rootPath);
        const stat = fs.lstatSync(root, { bigint: true });
        if (!stat.isDirectory()) return { ok: false, status: 403, error: 'Configured file root is not a directory' };
        const request: WorkerRequest = { ...operation, anchor: { dev: String(stat.dev), ino: String(stat.ino) } };
        const input = JSON.stringify(request);
        if (Buffer.byteLength(input) > 16 * 1024 * 1024) return { ok: false, status: 413, error: 'File request too large' };
        const program = `process.stdout.write(JSON.stringify((${confinedFileWorker.toString()})(JSON.parse(require('node:fs').readFileSync(0, 'utf8')))))`;
        const output = execFileSync(process.execPath, ['--input-type=commonjs', '--eval', program], {
            cwd: root, input, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
            env: {}, windowsHide: true,
        });
        const result = JSON.parse(output) as FileOperationResult;
        if (result.ok && (result.anchor?.dev !== request.anchor.dev || result.anchor?.ino !== request.anchor.ino)) {
            return { ok: false, status: 403, error: 'File worker root identity did not match' };
        }
        return result;
    } catch (error) {
        return { ok: false, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, error: 'Anchored file operation unavailable' };
    }
}
