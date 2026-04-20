/**
 * TITAN Constants
 */
import { homedir } from 'os';
import { join } from 'path';

export const TITAN_VERSION = '4.12.0';
export const TITAN_NAME = 'TITAN';
export const TITAN_FULL_NAME = 'The Intelligent Task Automation Network';
export const TITAN_ASCII_LOGO = `
╔══════════════════════════════════════════════════════╗
║                                                      ║
║  ████████╗██╗████████╗ █████╗ ███╗   ██╗             ║
║     ██║   ██║   ██║   ██╔══██╗████╗  ██║             ║
║     ██║   ██║   ██║   ███████║██╔██╗ ██║             ║
║     ██║   ██║   ██║   ██╔══██║██║╚██╗██║             ║
║     ██║   ██║   ██║   ██║  ██║██║ ╚████║             ║
║     ╚═╝   ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝             ║
║                                                      ║
║  The Intelligent Task Automation Network             ║
║  v${TITAN_VERSION}  •  by Tony Elliott               ║
╚══════════════════════════════════════════════════════╝`;

// Paths
// Hunt Finding #03 (2026-04-14): honor TITAN_HOME env var if set.
// Previously this was hardcoded to `~/.titan`, which meant:
//   - Docker containers couldn't override the config path
//   - Shared machines couldn't isolate per-user state
//   - Test fixtures couldn't run against an isolated home
//   - The systemd unit's `Environment=TITAN_HOME=...` was silently ignored
// The env var is read once at module load (constants are resolved at import time).
// If TITAN_HOME starts with `~/`, expand it to the user's home dir.
function resolveTitanHome(): string {
    const envHome = process.env.TITAN_HOME;
    if (envHome && envHome.trim().length > 0) {
        const trimmed = envHome.trim();
        if (trimmed.startsWith('~/')) {
            return join(homedir(), trimmed.slice(2));
        }
        if (trimmed === '~') {
            return homedir();
        }
        return trimmed;
    }
    return join(homedir(), '.titan');
}
export const TITAN_HOME = resolveTitanHome();
export const TITAN_CONFIG_PATH = join(TITAN_HOME, 'titan.json');
export const TITAN_DB_PATH = join(TITAN_HOME, 'titan.db');
export const TITAN_WORKSPACE = join(TITAN_HOME, 'workspace');
export const TITAN_SKILLS_DIR = join(TITAN_WORKSPACE, 'skills');
export const TITAN_LOGS_DIR = join(TITAN_HOME, 'logs');
export const TITAN_MEMORY_DIR = join(TITAN_HOME, 'memory');

// Workspace prompt files (injected into agent context)
export const AGENTS_MD = join(TITAN_WORKSPACE, 'AGENTS.md');
export const SOUL_MD = join(TITAN_WORKSPACE, 'SOUL.md');
export const TOOLS_MD = join(TITAN_WORKSPACE, 'TOOLS.md');
export const TITAN_MD_FILENAME = 'TITAN.md';
export const AUTOPILOT_MD = join(TITAN_HOME, 'AUTOPILOT.md');
export const AUTOPILOT_RUNS_PATH = join(TITAN_HOME, 'autopilot-runs.jsonl');
export const TITAN_CREDENTIALS_DIR = join(TITAN_HOME, 'credentials');

// Income & lead tracking
export const INCOME_LEDGER_PATH = join(TITAN_HOME, 'income-ledger.jsonl');
export const FREELANCE_LEADS_PATH = join(TITAN_HOME, 'freelance-leads.jsonl');
export const FREELANCE_PROFILE_PATH = join(TITAN_HOME, 'freelance-profile.json');
export const LEADS_PATH = join(TITAN_HOME, 'leads.jsonl');

// Gateway defaults
export const DEFAULT_GATEWAY_HOST = '0.0.0.0';
export const DEFAULT_GATEWAY_PORT = 48420;
export const DEFAULT_WEB_PORT = 48421;

// Agent defaults
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-20250514';
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TEMPERATURE = 0.7;
export const MAX_CONTEXT_MESSAGES = 50;
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Security
export const DEFAULT_SANDBOX_MODE = 'host';
/** Default allowed tools. Empty = allow ALL registered tools.
 *  Use security.deniedTools to block specific tools instead. */
export const ALLOWED_TOOLS_DEFAULT: string[] = [];
export const DENIED_TOOLS_DEFAULT: string[] = [];
