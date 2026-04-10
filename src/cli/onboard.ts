/**
 * TITAN — Onboarding Wizard
 * Interactive setup for first-time users. Covers all key settings.
 */
import { select, input, confirm, password, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { exec } from 'child_process';
import { saveConfig, getDefaultConfig } from '../config/config.js';
import { TITAN_HOME, TITAN_WORKSPACE, TITAN_SKILLS_DIR, TITAN_CONFIG_PATH } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { initMemory } from '../memory/memory.js';
import { loadProfile, saveProfile } from '../memory/relationship.js';


// ─── Ollama helpers ───────────────────────────────────────────────
async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
    try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const json = await res.json() as { models?: { name: string }[] };
        return (json.models || []).map((m) => m.name).filter(Boolean);
    } catch {
        return [];
    }
}

// ─── API key validation ──────────────────────────────────────────
// Tests a provider key against its real models endpoint.
// Returns { ok: true } on success or { ok: false, error: string } on failure.
// Used by the onboarding wizard to catch typo'd / expired / fake keys
// BEFORE the user finishes setup and hits a generic 500 in the gateway.
async function validateProviderKey(
    provider: string,
    apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
    if (!apiKey || apiKey.trim().length === 0) {
        return { ok: false, error: 'Key is empty' };
    }
    const trimmed = apiKey.trim();
    try {
        const ctl = AbortSignal.timeout(8000);
        if (provider === 'anthropic') {
            const res = await fetch('https://api.anthropic.com/v1/models', {
                method: 'GET',
                headers: { 'x-api-key': trimmed, 'anthropic-version': '2023-06-01' },
                signal: ctl,
            });
            if (res.status === 401 || res.status === 403) return { ok: false, error: 'Authentication failed (401/403)' };
            if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
            return { ok: true };
        }
        if (provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/models', {
                method: 'GET',
                headers: { Authorization: `Bearer ${trimmed}` },
                signal: ctl,
            });
            if (res.status === 401 || res.status === 403) return { ok: false, error: 'Authentication failed (401/403)' };
            if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
            return { ok: true };
        }
        if (provider === 'google') {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmed)}`,
                { method: 'GET', signal: ctl },
            );
            if (res.status === 401 || res.status === 403 || res.status === 400) {
                return { ok: false, error: `Authentication failed (${res.status})` };
            }
            if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
            return { ok: true };
        }
        // Unknown provider — skip validation, accept the key
        return { ok: true };
    } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('aborted')) return { ok: false, error: 'Request timed out (network or wrong endpoint)' };
        return { ok: false, error: msg };
    }
}

// Captures and validates an API key with retry. User can also skip.
// Returns the validated key, or empty string if user chose to skip.
async function captureAndValidateKey(provider: string): Promise<string> {
    for (;;) { // retry loop until user provides a valid key, skips, or forces
        const apiKey = await password({
            message: `Paste your ${provider} API key here (input is hidden):`,
            mask: '*',
        });
        if (!apiKey || apiKey.trim().length === 0) {
            const skip = await confirm({
                message: 'No key entered. Skip validation and continue anyway?',
                default: false,
            });
            if (skip) return '';
            continue;
        }
        process.stdout.write(chalk.gray(`  → Testing key against ${provider}... `));
        const result = await validateProviderKey(provider, apiKey);
        if (result.ok) {
            console.log(chalk.green('✅ valid'));
            return apiKey.trim();
        }
        console.log(chalk.red(`❌ ${result.error}`));
        const choice = await select({
            message: 'What would you like to do?',
            choices: [
                { name: '🔁 Re-enter the key', value: 'retry' },
                { name: '⏭️  Skip key validation and use it anyway (advanced)', value: 'force' },
                { name: '❌ Skip this provider', value: 'skip' },
            ],
        });
        if (choice === 'retry') continue;
        if (choice === 'force') return apiKey.trim();
        if (choice === 'skip') return '';
    }
}

import { TITAN_VERSION } from '../utils/constants.js';

function printLogo(): void {
    const c = chalk;
    const border = c.cyan;
    const row1 = c.yellowBright;
    const row2 = c.yellow;
    const row3 = c.greenBright;
    const row4 = c.cyanBright;
    const row5 = c.blueBright;
    const tagline = c.white;
    const credit = c.magentaBright;
    const ver = c.gray;

    console.log('');
    console.log(border('  ╔══════════════════════════════════════════════════════════╗'));
    console.log(border('  ║                                                          ║'));
    console.log(border('  ║  ') + row1('████████╗██╗████████╗  █████╗  ███╗   ██╗') + border('          ║'));
    console.log(border('  ║  ') + row2('   ██║   ██║   ██║   ██╔══██╗ ████╗  ██║') + border('          ║'));
    console.log(border('  ║  ') + row3('   ██║   ██║   ██║   ███████║ ██╔██╗ ██║') + border('          ║'));
    console.log(border('  ║  ') + row4('   ██║   ██║   ██║   ██╔══██║ ██║╚██╗██║') + border('          ║'));
    console.log(border('  ║  ') + row5('   ██║   ██║   ██║   ██║  ██║ ██║ ╚████║') + border('          ║'));
    console.log(border('  ║  ') + c.blue('   ╚═╝   ╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚═╝  ╚═══╝') + border('          ║'));
    console.log(border('  ║                                                          ║'));
    console.log(border('  ║  ') + tagline('The Intelligent Task Automation Network') + border('           ║'));
    console.log(border('  ║  ') + ver(`v${TITAN_VERSION}`) + c.gray('  •  ') + credit('by Tony Elliott') + border('                         ║'));
    console.log(border('  ╚══════════════════════════════════════════════════════════╝'));
    console.log('');
}

// ─── Main wizard ──────────────────────────────────────────────────
export async function runOnboard(_installDaemon?: boolean): Promise<boolean> {
    printLogo();
    console.log(chalk.gray('  Welcome! This wizard will configure your personal AI assistant.'));
    console.log(chalk.gray('  Press Ctrl+C at any time to cancel.\n'));


    const config = getDefaultConfig();

    // ─── Step 0: System Check + Profile ──────────────────────────
    console.log(chalk.yellow('─── Step 0: System Check ───\n'));

    // Node.js version
    console.log(chalk.green(`  ✅ Node.js ${process.version}`));

    // Check Ollama
    const ollamaModelsCheck = await fetchOllamaModels('http://localhost:11434');
    if (ollamaModelsCheck.length > 0) {
        console.log(chalk.green(`  ✅ Ollama detected (${ollamaModelsCheck.length} model(s): ${ollamaModelsCheck.slice(0, 3).join(', ')}${ollamaModelsCheck.length > 3 ? ', ...' : ''})`));
    } else {
        console.log(chalk.yellow('  ⚠️  Ollama not detected (local free AI unavailable — install from ollama.ai)'));
    }

    // Check Docker
    await new Promise<void>((resolve) => {
        exec('docker info --format "{{.ServerVersion}}"', { timeout: 3000 }, (err, stdout) => {
            if (!err && stdout.trim()) {
                console.log(chalk.green(`  ✅ Docker available (v${stdout.trim()} — docker sandbox mode enabled)`));
            } else {
                console.log(chalk.yellow('  ⚠️  Docker not found (docker sandbox mode won\'t be available)'));
            }
            resolve();
        });
    });

    console.log('');
    console.log(chalk.yellow('─── Step 0: Personalization ───\n'));
    console.log(chalk.gray('  This helps TITAN respond in your style — like a JARVIS that knows you.\n'));

    const profileName = await input({
        message: 'Your first name (optional, for personalization):',
        default: '',
    });

    const profileLevel = await select({
        message: 'Your technical level:',
        choices: [
            { name: 'Beginner — explain everything in plain English', value: 'beginner' },
            { name: 'Intermediate — I know the basics', value: 'intermediate' },
            { name: 'Expert — no hand-holding', value: 'expert' },
        ],
    });

    // ─── Step 1: Primary AI Provider ─────────────────────────────
    console.log(chalk.yellow('\n─── Step 1 of 7: AI Provider ───\n'));

    const provider = await select({
        message: 'Which AI provider would you like to use as your primary?',
        choices: [
            { name: '🟣 Anthropic (Claude) — Best reasoning, recommended', value: 'anthropic' },
            { name: '🟢 OpenAI (GPT-4o) — Great all-rounder', value: 'openai' },
            { name: '🔵 Google (Gemini) — Fast & multimodal', value: 'google' },
            { name: '🟠 Ollama (Local) — Free, private, runs on your machine', value: 'ollama' },
        ],
    });

    // ─── Step 2: Model Selection ──────────────────────────────────
    console.log(chalk.yellow('\n─── Step 2 of 7: Model ───\n'));

    if (provider === 'ollama') {
        const ollamaUrl = await input({
            message: 'Ollama base URL:',
            default: 'http://localhost:11434',
        });
        config.providers.ollama.baseUrl = ollamaUrl;

        console.log(chalk.gray(`\n  🔍 Detecting models at ${ollamaUrl}...`));
        const installedModels = await fetchOllamaModels(ollamaUrl);

        if (installedModels.length > 0) {
            console.log(chalk.green(`  ✅ Found ${installedModels.length} installed model(s)\n`));
            const chosen = await select({
                message: 'Select a model to use:',
                choices: installedModels.map((m) => ({ name: m, value: `ollama/${m}` })),
            });
            config.agent.model = chosen;
        } else {
            console.log(chalk.yellow('  ⚠️  No models detected (Ollama may not be running, or no models pulled yet).'));
            console.log(chalk.gray('  Run: ollama pull qwen3.5:4b   to install a model'));
            console.log(chalk.gray('  See: docs/MODELS.md for GPU-tiered model recommendations\n'));
            const modelName = await input({
                message: 'Enter the Ollama model name to use:',
                default: 'qwen3.5:4b',
            });
            config.agent.model = `ollama/${modelName}`;
        }
    } else {
        // Cloud provider — guide user to get their API key
        const keyGuides: Record<string, { url: string; hint: string; name: string }> = {
            anthropic: {
                url: 'https://console.anthropic.com/settings/keys',
                hint: 'Looks like: sk-ant-api03-...',
                name: 'Anthropic Console',
            },
            openai: {
                url: 'https://platform.openai.com/api-keys',
                hint: 'Looks like: sk-proj-... or sk-...',
                name: 'OpenAI Platform',
            },
            google: {
                url: 'https://aistudio.google.com/app/apikey',
                hint: 'Looks like: AIza...',
                name: 'Google AI Studio',
            },
        };

        const guide = keyGuides[provider];
        if (guide) {
            console.log(chalk.cyan(`\n  📋 To get your ${chalk.white(provider)} API key:`));
            console.log(chalk.white(`     → Go to: ${chalk.underline(guide.url)}`));
            console.log(chalk.gray(`     → ${guide.hint}`));
            console.log(chalk.green(`\n  🔒 Security guarantee:`));
            console.log(chalk.gray(`     Your key is stored ONLY on YOUR computer at:`));
            console.log(chalk.gray(`     ~/.titan/config.json`));
            console.log(chalk.gray(`     It goes directly to ${provider.charAt(0).toUpperCase() + provider.slice(1)}'s servers.`));
            console.log(chalk.gray(`     TITAN never sees it. No one else ever sees it.\n`));
        }

        const apiKey = await captureAndValidateKey(provider);

        const modelChoices: Record<string, { name: string; value: string }[]> = {
            anthropic: [
                { name: 'claude-sonnet-4-20250514 (Latest, recommended)', value: 'anthropic/claude-sonnet-4-20250514' },
                { name: 'claude-opus-4-0 (Most capable, slower)', value: 'anthropic/claude-opus-4-0' },
                { name: 'claude-3-5-haiku-20241022 (Fastest, cheapest)', value: 'anthropic/claude-3-5-haiku-20241022' },
            ],
            openai: [
                { name: 'gpt-4o (Recommended)', value: 'openai/gpt-4o' },
                { name: 'gpt-4o-mini (Fast & cheap)', value: 'openai/gpt-4o-mini' },
                { name: 'o3 (Best reasoning)', value: 'openai/o3' },
                { name: 'o4-mini (Fast reasoning)', value: 'openai/o4-mini' },
            ],
            google: [
                { name: 'gemini-2.5-flash (Recommended)', value: 'google/gemini-2.5-flash' },
                { name: 'gemini-2.5-pro (Most capable)', value: 'google/gemini-2.5-pro' },
                { name: 'gemini-2.0-flash (Fast)', value: 'google/gemini-2.0-flash' },
            ],
        };

        const models = modelChoices[provider] || [];
        const selectedModel = await select({
            message: 'Which model would you like to use?',
            choices: [...models, { name: '✏️  Enter manually', value: '__manual__' }],
        });

        if (selectedModel === '__manual__') {
            config.agent.model = await input({ message: 'Enter model identifier:' });
        } else {
            config.agent.model = selectedModel;
        }

        if (provider === 'anthropic') {
            config.providers.anthropic.apiKey = apiKey;
        } else if (provider === 'openai') {
            config.providers.openai.apiKey = apiKey;
        } else if (provider === 'google') {
            config.providers.google.apiKey = apiKey;
        }

        // Offer to add additional providers as fallback
        const addFallback = await confirm({
            message: 'Add a second provider as fallback (for failover if the primary is unavailable)?',
            default: false,
        });

        if (addFallback) {
            const fallbackProviders = ['anthropic', 'openai', 'google', 'ollama'].filter((p) => p !== provider);
            const fallback = await select({
                message: 'Select fallback provider:',
                choices: fallbackProviders.map((p) => ({ name: p.charAt(0).toUpperCase() + p.slice(1), value: p })),
            });
            if (fallback === 'ollama') {
                const ollamaUrl = await input({ message: 'Ollama base URL:', default: 'http://localhost:11434' });
                config.providers.ollama.baseUrl = ollamaUrl;
                const ollamaModels = await fetchOllamaModels(ollamaUrl);
                if (ollamaModels.length === 0) {
                    console.log(chalk.yellow(`  ⚠️  Ollama at ${ollamaUrl} is unreachable or has no models — fallback may not work.`));
                } else {
                    console.log(chalk.green(`  ✅ Ollama fallback ready (${ollamaModels.length} models available)`));
                }
            } else {
                const fallbackKey = await captureAndValidateKey(fallback);
                if (fallback === 'anthropic') config.providers.anthropic.apiKey = fallbackKey;
                else if (fallback === 'openai') config.providers.openai.apiKey = fallbackKey;
                else if (fallback === 'google') config.providers.google.apiKey = fallbackKey;
            }
        }
    }

    // ─── Step 3: Autonomy Mode ────────────────────────────────────
    console.log(chalk.yellow('\n─── Step 3 of 7: Autonomy ───\n'));
    console.log(chalk.gray('  Controls how independently TITAN acts.\n'));

    const autonomyMode = await select({
        message: 'How much autonomy should TITAN have?',
        choices: [
            {
                name: '🟡 Supervised (Recommended) — safe ops run freely, dangerous ops ask first',
                value: 'supervised',
            },
            {
                name: '🟢 Autonomous — full auto, acts without asking. Best for power users.',
                value: 'autonomous',
            },
            {
                name: '🔴 Locked — every single action requires your approval.',
                value: 'locked',
            },
        ],
    });
    config.autonomy.mode = autonomyMode as 'supervised' | 'autonomous' | 'locked';

    // ─── Step 4: Security / Sandbox ──────────────────────────────
    console.log(chalk.yellow('\n─── Step 4 of 7: Security ───\n'));

    const sandboxMode = await select({
        message: 'Sandbox mode for shell commands:',
        choices: [
            { name: '🖥️  Host (Full access — single user machines)', value: 'host' },
            { name: '🐳 Docker (Isolated containers — recommended for shared machines)', value: 'docker' },
            { name: '🚫 None (No restrictions — not recommended)', value: 'none' },
        ],
    });
    config.security.sandboxMode = sandboxMode as 'host' | 'docker' | 'none';

    const enableShield = await confirm({
        message: 'Enable Prompt Injection Shield? (blocks attempts to hijack TITAN via chat messages)',
        default: true,
    });
    config.security.shield.enabled = enableShield;
    if (enableShield) {
        const shieldMode = await select({
            message: 'Shield strictness:',
            choices: [
                { name: 'Strict (recommended) — blocks suspicious payloads aggressively', value: 'strict' },
                { name: 'Standard — blocks only obvious injection attempts', value: 'standard' },
            ],
        });
        config.security.shield.mode = shieldMode as 'strict' | 'standard';
    }

    // ─── Step 5: Channels ─────────────────────────────────────────
    console.log(chalk.yellow('\n─── Step 5 of 7: Messaging Channels ───\n'));
    console.log(chalk.gray('  Connect TITAN to Discord, Telegram, Slack, etc. (all optional)\n'));

    const channelChoices = await checkbox({
        message: 'Which channels would you like to configure? (space to select, enter to continue)',
        choices: [
            { name: '🎮 Discord', value: 'discord' },
            { name: '✈️  Telegram', value: 'telegram' },
            { name: '💼 Slack', value: 'slack' },
            { name: '💬 Google Chat (webhook)', value: 'googlechat' },
            { name: '📱 WhatsApp (requires phone pairing after setup)', value: 'whatsapp' },
            { name: '⏭️  Skip — configure later in Mission Control Settings', value: 'skip' },
        ],
    });

    if (!channelChoices.includes('skip')) {
        for (const channel of channelChoices) {
            if (channel === 'whatsapp') {
                config.channels.whatsapp.enabled = true;
                console.log(chalk.gray('  ℹ️  Run titan pairing after setup to link your phone'));
            } else if (channel === 'googlechat') {
                const webhook = await input({ message: '  Google Chat incoming webhook URL:' });
                config.channels.googlechat.enabled = true;
                config.channels.googlechat.token = webhook;
            } else {
                const token = await password({ message: `  ${channel} bot token:`, mask: '*' });
                if (channel === 'discord') {
                    config.channels.discord.enabled = true;
                    config.channels.discord.token = token;
                } else if (channel === 'telegram') {
                    config.channels.telegram.enabled = true;
                    config.channels.telegram.token = token;
                } else if (channel === 'slack') {
                    config.channels.slack.enabled = true;
                    config.channels.slack.token = token;
                }
            }
        }
    }

    // ─── Step 6: Gateway ─────────────────────────────────────────
    console.log(chalk.yellow('\n─── Step 6 of 7: Gateway ───\n'));
    console.log(chalk.gray('  Mission Control is served at http://127.0.0.1:<port>\n'));

    const useDefaultPort = await confirm({
        message: 'Use default gateway port (48420)?',
        default: true,
    });
    if (!useDefaultPort) {
        const port = await input({ message: 'Enter gateway port:', default: '48420' });
        config.gateway.port = parseInt(port, 10);
    }

    const enableGatewayAuth = await confirm({
        message: 'Enable gateway authentication? (recommended if accessible from other devices)',
        default: false,
    });
    if (enableGatewayAuth) {
        const authMode = await select({
            message: 'Authentication mode:',
            choices: [
                { name: 'Token (API key in request header)', value: 'token' },
                { name: 'Password (browser prompt)', value: 'password' },
            ],
        });
        config.gateway.auth.mode = authMode as 'token' | 'password';
        if (authMode === 'token') {
            config.gateway.auth.token = await password({ message: 'Set a gateway token:', mask: '*' });
        } else {
            config.gateway.auth.password = await password({ message: 'Set a gateway password:', mask: '*' });
        }
    }

    // ─── Step 6.5: Daemon Installation ───────────────────────────
    console.log(chalk.yellow('\n─── Auto-Start: System Service ───\n'));
    console.log(chalk.gray('  Install TITAN as a system service so it auto-starts on login.\n'));

    let daemonInstalled = false;
    const installDaemon = await confirm({
        message: 'Install TITAN as a system service? (auto-starts on login)',
        default: true,
    });
    if (installDaemon) {
        await installDaemonService();
        daemonInstalled = true;
    }

    // ─── Step 7: Logging ─────────────────────────────────────────
    console.log(chalk.yellow('\n─── Step 7 of 7: Logging ───\n'));

    const logLevel = await select({
        message: 'Log level:',
        choices: [
            { name: 'info (recommended)', value: 'info' },
            { name: 'debug (verbose — for troubleshooting)', value: 'debug' },
            { name: 'warn (quiet — warnings and errors only)', value: 'warn' },
            { name: 'silent (no logs)', value: 'silent' },
        ],
    });
    config.logging.level = logLevel as 'info' | 'debug' | 'warn' | 'silent';

    // ─── Finalise ─────────────────────────────────────────────────
    console.log(chalk.yellow('\n─── Setting up workspace ───\n'));
    ensureDir(TITAN_HOME);
    ensureDir(TITAN_WORKSPACE);
    ensureDir(TITAN_SKILLS_DIR);
    initMemory();
    saveConfig(config);

    // Save user profile
    if (profileName || profileLevel) {
        const profile = loadProfile();
        if (profileName) profile.name = profileName;
        if (profileLevel) profile.technicalLevel = profileLevel as typeof profile.technicalLevel;
        saveProfile(profile);
    }

    const modeEmoji = autonomyMode === 'autonomous' ? '🟢' : autonomyMode === 'locked' ? '🔴' : '🟡';
    const providerName = config.agent.model.split('/')[0];
    const modelName = config.agent.model.split('/').slice(1).join('/');
    const enabledChannels = ['discord','telegram','slack','googlechat','whatsapp']
        .filter(ch => config.channels[ch as keyof typeof config.channels]?.enabled);

    console.log(chalk.green('\n╔══════════════════════════════════════════════════╗'));
    console.log(chalk.green('║   ✅  TITAN is ready!                            ║'));
    console.log(chalk.green('╚══════════════════════════════════════════════════╝\n'));
    console.log(chalk.white('  Your configuration:'));
    if (profileName) console.log(chalk.gray(`    Name:     ${profileName} (${profileLevel})`));
    console.log(chalk.gray(`    Provider: ${providerName} / ${modelName}`));
    console.log(chalk.gray(`    Autonomy: ${modeEmoji} ${autonomyMode}`));
    console.log(chalk.gray(`    Sandbox:  ${config.security.sandboxMode}`));
    console.log(chalk.gray(`    Logs:     ${config.logging.level}`));
    if (enabledChannels.length > 0) {
        console.log(chalk.gray(`    Channels: ${enabledChannels.map(ch => '✅ ' + ch).join(', ')}`));
    }
    console.log(chalk.gray(`    Service:  ${daemonInstalled ? '✅ Installed (auto-starts on login)' : '❌ Manual only (run titan gateway)'}`));
    console.log(chalk.gray(`    Config:   ${TITAN_CONFIG_PATH}`));
    console.log(chalk.white('\n  Next steps:'));
    console.log(chalk.cyan('    titan gateway          ') + chalk.gray(`→ Open Mission Control at http://127.0.0.1:${config.gateway.port}`));
    console.log(chalk.cyan('    titan agent -m "Hello" ') + chalk.gray('→ Send a direct message'));
    console.log(chalk.cyan('    titan doctor           ') + chalk.gray('→ Diagnose configuration & connectivity'));
    console.log();

    const launch = await confirm({
        message: `Start Mission Control (web GUI) now at http://127.0.0.1:${config.gateway.port}?`,
        default: true,
    });

    return launch;
}

async function installDaemonService(): Promise<void> {
    const platform = process.platform;

    if (platform === 'linux') {
        console.log(chalk.gray('Creating systemd user service...'));
        const serviceContent = `[Unit]
Description=TITAN Gateway
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${process.argv[1]} gateway
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
        const { writeFileSync, mkdirSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const { homedir } = await import('os');
        const serviceDir = join(homedir(), '.config', 'systemd', 'user');
        if (!existsSync(serviceDir)) mkdirSync(serviceDir, { recursive: true });
        writeFileSync(join(serviceDir, 'titan.service'), serviceContent);
        console.log(chalk.green('  Service file installed. Enable with:'));
        console.log(chalk.gray('  $ systemctl --user enable titan'));
        console.log(chalk.gray('  $ systemctl --user start titan'));
    } else if (platform === 'darwin') {
        console.log(chalk.yellow('  macOS: create a LaunchAgent plist manually to run as a daemon.'));
    } else {
        console.log(chalk.yellow('  Daemon installation not supported on this platform yet.'));
    }
}
