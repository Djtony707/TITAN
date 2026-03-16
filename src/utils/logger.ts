/**
 * TITAN Logger — Structured logging with levels and colors
 */
import chalk from 'chalk';
import { createWriteStream, mkdirSync } from 'fs';
import type { WriteStream } from 'fs';

let fileStream: WriteStream | null = null;
let logFilePath: string | null = null;

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    SILENT = 4,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: chalk.gray('DEBUG'),
    [LogLevel.INFO]: chalk.cyan('INFO '),
    [LogLevel.WARN]: chalk.yellow('WARN '),
    [LogLevel.ERROR]: chalk.red('ERROR'),
    [LogLevel.SILENT]: '',
};

const LEVEL_NAMES: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO ',
    [LogLevel.WARN]: 'WARN ',
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.SILENT]: '     ',
};
const ansiStrip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

let currentLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

export function getLogLevel(): LogLevel {
    return currentLevel;
}

function formatLocalTimestamp(): string {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function formatTimestamp(): string {
    return chalk.gray(formatLocalTimestamp());
}

function log(level: LogLevel, component: string, message: string, ...args: unknown[]): void {
    if (level < currentLevel) return;
    const prefix = `${formatTimestamp()} ${LEVEL_LABELS[level]} ${chalk.blue(`[${component}]`)}`;
    console.log(`${prefix} ${message}`, ...args);
    if (fileStream) {
        const ts = formatLocalTimestamp();
        const extra = args.length
            ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
            : '';
        fileStream.write(`${ts} ${LEVEL_NAMES[level]} [${component}] ${ansiStrip(message)}${extra}\n`);
    }
}

export const logger = {
    debug: (component: string, msg: string, ...args: unknown[]) => log(LogLevel.DEBUG, component, msg, ...args),
    info: (component: string, msg: string, ...args: unknown[]) => log(LogLevel.INFO, component, msg, ...args),
    warn: (component: string, msg: string, ...args: unknown[]) => log(LogLevel.WARN, component, msg, ...args),
    error: (component: string, msg: string, ...args: unknown[]) => log(LogLevel.ERROR, component, msg, ...args),
};

export function initFileLogger(logDir: string): void {
    if (fileStream) return; // idempotent
    mkdirSync(logDir, { recursive: true });
    const date = formatLocalTimestamp().slice(0, 10);
    logFilePath = `${logDir}/titan-${date}.log`;
    fileStream = createWriteStream(logFilePath, { flags: 'a', encoding: 'utf-8' });
    fileStream.on('error', (err) => {
        console.error(`[Logger] File write error: ${err.message}`);
    });
}

export function getLogFilePath(): string | null {
    return logFilePath;
}

export default logger;
