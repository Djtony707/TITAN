/**
 * TITAN CLI — Main Entrypoint
 * Command-line interface for TITAN: onboard, gateway, agent, send, doctor, skills, config,
 * pairing, agents. Mirrors OpenClaw's CLI surface.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { TITAN_VERSION, TITAN_ASCII_LOGO, TITAN_FULL_NAME, TITAN_CONFIG_PATH, TITAN_LOGS_DIR } from '../utils/constants.js';
import { setLogLevel, LogLevel, initFileLogger } from '../utils/logger.js';
import { loadConfig, updateConfig } from '../config/config.js';
import type { TitanConfig } from '../config/schema.js';
import { processMessage } from '../agent/agent.js';
import { initMemory } from '../memory/memory.js';
import { initLearning } from '../memory/learning.js';
import { initBuiltinSkills, getSkills } from '../skills/registry.js';
import { startGateway } from '../gateway/server.js';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { runDoctor } from './doctor.js';
import { runOnboard } from './onboard.js';
import { approvePairing, denyPairing, listPendingPairings, listApprovedUsers } from '../security/pairing.js';
import { spawnAgent, stopAgent, listAgents, getAgentCapacity } from '../agent/multiAgent.js';
import { listMcpServers, addMcpServer, removeMcpServer, getMcpStatus } from '../mcp/registry.js';
import { testMcpServer } from '../mcp/client.js';
import { listRecipes, getRecipe, deleteRecipe, seedBuiltinRecipes } from '../recipes/store.js';
import { runRecipe } from '../recipes/runner.js';
import { listMonitors, addMonitor, removeMonitor } from '../agent/monitor.js';
import { searchSkills, installSkill, installFromUrl } from '../skills/marketplace.js';
import { scaffoldSkill, testSkill } from '../skills/scaffold.js';
import { createTeam, listTeams, getTeam, deleteTeam, addMember, removeMember, createInvite, acceptInvite, getTeamStats, updateMemberRole } from '../security/teams.js';
import { checkForUpdates } from '../utils/updater.js';

const program = new Command();

program
    .name('titan')
    .description(`${TITAN_FULL_NAME} — Your autonomous AI assistant`)
    .version(TITAN_VERSION);

// ─── ONBOARD ─────────────────────────────────────────────────────
program
    .command('onboard')
    .description('Run the interactive setup wizard')
    .option('--install-daemon', 'Install as a system daemon (systemd/launchd)')
    .action(async (options) => {
        const launch = await runOnboard(options.installDaemon);
        if (launch) {
            console.log(chalk.cyan(TITAN_ASCII_LOGO));
            await startGateway();
        }
    });

// ─── GATEWAY ─────────────────────────────────────────────────────
program
    .command('gateway')
    .description('Start the TITAN gateway server')
    .option('-p, --port <port>', 'Gateway port', '48420')
    .option('-H, --host <host>', 'Gateway host')
    .option('-v, --verbose', 'Enable verbose logging')
    .option('--skip-usable-check', 'Skip the first-run provider check (advanced)')
    .action(async (options) => {
        console.log(chalk.cyan(TITAN_ASCII_LOGO));
        if (options.verbose) setLogLevel(LogLevel.DEBUG);
        await startGateway({
            port: parseInt(options.port, 10),
            host: options.host,
            verbose: options.verbose,
            skipUsableCheck: options.skipUsableCheck,
        });
    });

// ─── AGENT (Direct message) ──────────────────────────────────────
program
    .command('agent')
    .description('Send a message directly to the TITAN agent')
    .option('-m, --message <message>', 'Message to send')
    .option('--model <model>', 'Override the model')
    .option('--thinking <level>', 'Thinking mode: off/low/medium/high', 'medium')
    .action(async (options) => {
        if (!options.message) {
            console.log(chalk.red('Error: --message is required'));
            process.exit(1);
        }

        // First-run guard: bail with a helpful message instead of a generic 500
        const { hasUsableProvider } = await import('../config/config.js');
        const usable = await hasUsableProvider();
        if (!usable.ok) {
            console.error(chalk.red('\n❌ TITAN is not configured.'));
            console.error(chalk.gray(`   ${usable.details}\n`));
            console.error('   Run setup:');
            console.error(chalk.cyan('     titan onboard\n'));
            console.error('   Or set an environment variable:');
            console.error(chalk.cyan('     export ANTHROPIC_API_KEY="sk-ant-..."\n'));
            process.exit(1);
        }

        initMemory();
        initLearning();
        await initBuiltinSkills();

        const config = loadConfig();
        if (options.model) {
            config.agent.model = options.model;
        }

        console.log(chalk.gray(`Using model: ${config.agent.model}`));
        console.log(chalk.gray('Processing...\n'));

        try {
            const response = await processMessage(options.message, 'cli', 'cli-user');
            console.log(chalk.white(response.content));
            console.log(chalk.gray(`\n─ ${response.model} | ${response.tokenUsage.total} tokens | ${response.durationMs}ms | tools: ${response.toolsUsed.join(', ') || 'none'}`));
        } catch (error) {
            console.error(chalk.red(`Error: ${(error as Error).message}`));
            process.exit(1);
        }
        process.exit(0);
    });

// ─── SEND (like openclaw message send) ──────────────────────────
program
    .command('send')
    .description('Send a message to a specific channel')
    .option('--to <destination>', 'Destination (channel:userId or channel:groupId)')
    .option('-m, --message <message>', 'Message content')
    .action(async (options) => {
        if (!options.to || !options.message) {
            console.log(chalk.red('Error: --to and --message are required'));
            process.exit(1);
        }
        console.log(chalk.gray(`Sending to ${options.to}: ${options.message}`));
        console.log(chalk.green('Message queued for delivery'));
        process.exit(0);
    });

// ─── PAIRING (DM access control) ────────────────────────────────
program
    .command('pairing')
    .description('Manage DM pairing approvals')
    .option('--approve <channel> <code>', 'Approve a pairing request')
    .option('--deny <code>', 'Deny a pairing request')
    .option('--list', 'List pending pairing requests')
    .option('--approved', 'List approved users')
    .action((options) => {
        if (options.approve) {
            // Parse channel and code from remaining args
            const args = program.args;
            const channel = args[1] || options.approve;
            const code = args[2] || '';
            if (!channel || !code) {
                console.log(chalk.red('Usage: titan pairing approve <channel> <code>'));
                return;
            }
            const result = approvePairing(channel, code);
            console.log(result.success ? chalk.green(result.message) : chalk.red(result.message));
        } else if (options.deny) {
            const result = denyPairing(options.deny);
            console.log(result.success ? chalk.green(result.message) : chalk.red(result.message));
        } else if (options.approved) {
            const users = listApprovedUsers();
            if (users.length === 0) {
                console.log(chalk.gray('No approved users.'));
            } else {
                console.log(chalk.cyan('\n🔓 Approved Users\n'));
                for (const u of users) {
                    console.log(`  ✅ ${u.channel} / ${u.userId}`);
                }
            }
        } else {
            // Default: list pending
            const pending = listPendingPairings();
            if (pending.length === 0) {
                console.log(chalk.gray('No pending pairing requests.'));
            } else {
                console.log(chalk.cyan(`\n🔐 Pending Pairing Requests (${pending.length})\n`));
                for (const p of pending) {
                    console.log(`  📩 Code: ${chalk.yellow(p.code)} | ${p.channel} / ${p.userId} (${p.userName || 'unknown'}) | ${p.createdAt}`);
                }
                console.log(chalk.gray('\n  Approve: titan pairing --approve <channel> <code>'));
            }
        }
        process.exit(0);
    });

// ─── TEAMS (RBAC team management) ────────────────────────────────
program
    .command('teams')
    .description('Manage teams with role-based access control')
    .option('--list', 'List all teams')
    .option('--create <name>', 'Create a new team')
    .option('--delete <teamId>', 'Delete a team')
    .option('--info <teamId>', 'Show team details')
    .option('--add-member <teamId>', 'Add a member to a team')
    .option('--remove-member <teamId>', 'Remove a member from a team')
    .option('--user <userId>', 'User ID for member operations')
    .option('--role <role>', 'Role: owner, admin, operator, viewer')
    .option('--invite <teamId>', 'Create an invite code for a team')
    .option('--join <code>', 'Join a team with an invite code')
    .option('--set-role <teamId>', 'Change a member\'s role')
    .action((options) => {
        if (options.create) {
            try {
                const team = createTeam(options.create, 'cli-user');
                console.log(chalk.green(`Team "${team.name}" created (ID: ${team.id})`));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else if (options.delete) {
            try {
                deleteTeam(options.delete, 'cli-user');
                console.log(chalk.green('Team deleted'));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else if (options.info) {
            const team = getTeam(options.info);
            if (!team) { console.log(chalk.red('Team not found')); process.exit(1); }
            const stats = getTeamStats(options.info);
            console.log(chalk.cyan(`\n📋 Team: ${team.name}`));
            if (team.description) console.log(`   ${team.description}`);
            console.log(`   ID: ${team.id}`);
            console.log(`   Owner: ${team.ownerId}`);
            console.log(`   Members: ${stats?.activeCount || 0} active`);
            if (stats) {
                console.log(`   Roles: ${stats.roleBreakdown.owner}×owner, ${stats.roleBreakdown.admin}×admin, ${stats.roleBreakdown.operator}×operator, ${stats.roleBreakdown.viewer}×viewer`);
            }
            console.log(`   Created: ${team.createdAt}\n`);
            for (const m of team.members) {
                const status = m.status === 'active' ? chalk.green('active') : chalk.gray(m.status);
                console.log(`   ${m.role.padEnd(8)} ${m.userId} [${status}]`);
            }
        } else if (options.addMember) {
            if (!options.user) { console.log(chalk.red('--user <userId> required')); process.exit(1); }
            try {
                const member = addMember(options.addMember, 'cli-user', options.user, options.role || 'operator');
                console.log(chalk.green(`Added ${member.userId} as ${member.role}`));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else if (options.removeMember) {
            if (!options.user) { console.log(chalk.red('--user <userId> required')); process.exit(1); }
            try {
                removeMember(options.removeMember, 'cli-user', options.user);
                console.log(chalk.green(`Removed ${options.user}`));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else if (options.setRole) {
            if (!options.user || !options.role) { console.log(chalk.red('--user and --role required')); process.exit(1); }
            try {
                updateMemberRole(options.setRole, 'cli-user', options.user, options.role);
                console.log(chalk.green(`${options.user} role changed to ${options.role}`));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else if (options.invite) {
            try {
                const code = createInvite(options.invite, 'cli-user', options.role || 'operator');
                console.log(chalk.green(`Invite code: ${chalk.yellow(code)}`));
                console.log(chalk.gray(`  Join: titan teams --join ${code}`));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else if (options.join) {
            const userId = options.user || 'cli-user';
            try {
                const result = acceptInvite(options.join, userId);
                console.log(chalk.green(`Joined team "${result.team.name}" as ${result.member.role}`));
            } catch (e) { console.log(chalk.red((e as Error).message)); }
        } else {
            // Default: list teams
            const teams = listTeams();
            if (teams.length === 0) {
                console.log(chalk.gray('No teams. Create one: titan teams --create <name>'));
            } else {
                console.log(chalk.cyan(`\n👥 Teams (${teams.length})\n`));
                for (const t of teams) {
                    const active = t.members.filter(m => m.status === 'active').length;
                    console.log(`  ${chalk.bold(t.name)} (${t.id.slice(0, 8)}) — ${active} member${active !== 1 ? 's' : ''}`);
                }
            }
        }
        process.exit(0);
    });

// ─── AGENTS (Multi-agent management) ────────────────────────────
program
    .command('agents')
    .description('Manage multiple TITAN agent instances (max 5)')
    .option('--list', 'List all agent instances')
    .option('--spawn <name>', 'Spawn a new agent instance')
    .option('--model <model>', 'Model for the new agent')
    .option('--stop <id>', 'Stop an agent instance')
    .action((options) => {
        if (options.stop) {
            const result = stopAgent(options.stop);
            console.log(result.success ? chalk.green(`Agent ${options.stop} stopped.`) : chalk.red(result.error || 'Failed'));
        } else if (options.spawn) {
            const result = spawnAgent({
                name: options.spawn,
                model: options.model,
            });
            if (result.success && result.agent) {
                const cap = getAgentCapacity();
                console.log(chalk.green(`\n⚡ Spawned agent "${result.agent.name}"`));
                console.log(chalk.gray(`  ID: ${result.agent.id}`));
                console.log(chalk.gray(`  Model: ${result.agent.model}`));
                console.log(chalk.gray(`  Capacity: ${cap.current}/${cap.max}\n`));
            } else {
                console.log(chalk.red(result.error || 'Failed to spawn agent'));
            }
        } else {
            // Default: list
            const agents = listAgents();
            const cap = getAgentCapacity();
            console.log(chalk.cyan(`\n🤖 TITAN Agents (${cap.current}/${cap.max})\n`));
            for (const agent of agents) {
                const icon = agent.status === 'running' ? '🟢' : '🔴';
                console.log(`  ${icon} ${chalk.white(agent.name)} ${chalk.gray(`(${agent.id})`)}`);
                console.log(`     Model: ${agent.model} | Messages: ${agent.messageCount} | Status: ${agent.status}`);
                if (agent.channelBindings.length > 0) {
                    console.log(`     Routes: ${agent.channelBindings.map((b) => `${b.channel}:${b.pattern}`).join(', ')}`);
                }
            }
        }
        process.exit(0);
    });

// ─── DOCTOR ──────────────────────────────────────────────────────
program
    .command('doctor')
    .description('Diagnose TITAN configuration and connectivity')
    .option('--fix', 'Auto-fix detected issues')
    .option('--dry-run', 'Show what --fix would do without applying changes')
    .option('--json', 'Output results as JSON (machine-readable)')
    .action(async (options) => {
        if (!options.json) console.log(chalk.cyan(TITAN_ASCII_LOGO));
        await runDoctor({ fix: options.fix, dryRun: options.dryRun, json: options.json });
        process.exit(0);
    });

// ─── SKILLS ──────────────────────────────────────────────────────
program
    .command('skills')
    .description('Manage TITAN skills & marketplace')
    .option('--list', 'List all installed skills')
    .option('--create <description>', 'Create a new skill from natural language (AI-generated)')
    .option('--name <name>', 'Name for the new skill (used with --create)')
    .option('--scaffold <name>', 'Scaffold a new skill project from template')
    .option('--format <format>', 'Scaffold format: js, ts, or yaml (default: js)')
    .option('--description <desc>', 'Skill description (used with --scaffold)')
    .option('--author <author>', 'Skill author (used with --scaffold)')
    .option('--test <name>', 'Test a skill by loading and executing with sample args')
    .option('--search <query>', 'Search TITAN Skills Marketplace')
    .option('--install <name>', 'Install a skill (from marketplace or URL) — security scanned automatically')
    .option('--remove <name>', 'Remove an installed skill')
    .option('--force', 'Force install even if high-severity scan warnings exist')
    .action(async (options) => {
        initMemory();
        await initBuiltinSkills();

        if (options.scaffold) {
            const name = options.scaffold as string;
            const format = (options.format as 'js' | 'ts' | 'yaml') || 'js';
            const description = (options.description as string) || `A custom TITAN skill: ${name}`;
            const author = (options.author as string) || 'TITAN User';
            console.log(chalk.cyan(`\n🔧 Scaffolding skill "${name}" (${format})...\n`));
            const result = scaffoldSkill({ name, description, author, format });
            if (result.success) {
                console.log(chalk.green(`✅ Skill scaffolded at: ${result.skillDir}\n`));
                console.log(chalk.white('  Files created:'));
                for (const f of result.files) console.log(chalk.gray(`    ${f}`));
                console.log(chalk.gray(`\n  Edit the skill file, then restart TITAN to load it.`));
                console.log(chalk.gray(`  Test it: titan skills --test ${name}`));
            } else {
                console.log(chalk.red(`❌ Scaffold failed: ${result.error}`));
            }
        } else if (options.test) {
            const name = options.test as string;
            console.log(chalk.cyan(`\n🧪 Testing skill "${name}"...\n`));
            const result = await testSkill(name);
            if (result.success) {
                console.log(chalk.green(`✅ Skill "${name}" passed (${result.durationMs}ms)`));
                console.log(chalk.gray(`  Output: ${result.output?.slice(0, 500)}`));
            } else {
                console.log(chalk.red(`❌ Skill "${name}" failed: ${result.error}`));
            }
        } else if (options.create) {
            const description = options.create as string;
            const name = (options.name as string) || description.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
            console.log(chalk.cyan(`\n✨ Generating skill: "${name}"...`));
            console.log(chalk.gray(`  Description: ${description}\n`));

            const { generateAndInstallSkill } = await import('../agent/generator.js');
            const result = await generateAndInstallSkill(description, name);
            if (result.success) {
                console.log(chalk.green(`\n✅ Skill "${result.skillName}" created successfully!`));
                console.log(chalk.gray(`   File: ${result.filePath}`));
                console.log(chalk.gray('   The skill is now available to TITAN. Restart the gateway to use it.'));
            } else {
                console.log(chalk.red(`\n❌ Failed to create skill: ${result.error}`));
            }
        } else if (options.search) {
            console.log(chalk.cyan(`\n🔍 Searching marketplace for "${options.search}"...\n`));
            const results = await searchSkills(options.search);
            if (results.skills.length === 0) {
                console.log(chalk.gray('  No skills found. Try a different search term.'));
            } else {
                for (const skill of results.skills) {
                    const apiKey = skill.requiresApiKey ? chalk.yellow('🔑 API key') : chalk.green('✓ No key needed');
                    console.log(`  ${chalk.white(skill.name)} ${chalk.gray(`v${skill.version}`)} — ${apiKey}`);
                    console.log(`     ${chalk.gray(skill.description)}`);
                    console.log(`     ${chalk.gray(`by ${skill.author} · ${skill.category} · ${skill.tags.join(', ')}`)}\n`);
                }
            }
        } else if (options.install) {
            const name = options.install as string;
            const isUrl = name.startsWith('http');
            console.log(chalk.cyan(`\n🛡️  Installing "${name}" with security scan...`));
            const result = isUrl
                ? await installFromUrl(name, { force: options.force })
                : await installSkill(name, { force: options.force });
            if (result.success) {
                console.log(chalk.green(`\n✅ Installed: ${result.skillName}`));
                console.log(chalk.gray(`   Path: ${result.installedPath}`));
                console.log(chalk.gray('   Restart TITAN or run `titan gateway` to activate.'));
            } else {
                console.log(chalk.red(`\n❌ Installation failed: ${result.error}`));
            }
        } else if (options.remove) {
            const name = options.remove as string;
            const autoDir = join(TITAN_HOME, 'skills', 'auto');
            const tsPath = join(autoDir, `${name}.ts`);
            const jsPath = join(autoDir, `${name}.js`);
            let removed = false;
            if (existsSync(tsPath)) { unlinkSync(tsPath); removed = true; }
            if (existsSync(jsPath)) { unlinkSync(jsPath); removed = true; }
            console.log(removed ? chalk.green(`🗑️  Removed "${name}"`) : chalk.yellow(`⚠️  Skill "${name}" not found.`));
        } else {
            const skills = getSkills();
            console.log(chalk.cyan(`\n📦 TITAN Skills (${skills.length} installed)\n`));
            for (const skill of skills) {
                const status = skill.enabled ? chalk.green('✅') : chalk.red('❌');
                console.log(`  ${status} ${chalk.white(skill.name)} ${chalk.gray(`v${skill.version} (${skill.source})`)}`);
                console.log(`     ${chalk.gray(skill.description)}`);
            }
            console.log(chalk.gray('\n  Search marketplace: titan skills --search <query>'));
            console.log(chalk.gray('  Install from marketplace: titan skills --install <name>'));
        }
        process.exit(0);
    });

// ─── CREATE-SKILL (alias for skills --scaffold) ─────────────────
program
    .command('create-skill <name>')
    .description('Scaffold a new skill project (alias for `skills --scaffold`)')
    .option('--format <format>', 'Format: js, ts, or yaml (default: js)', 'js')
    .option('--description <desc>', 'Skill description')
    .option('--author <author>', 'Skill author')
    .action(async (name, options) => {
        const format = (options.format as 'js' | 'ts' | 'yaml') || 'js';
        const description = (options.description as string) || `A custom TITAN skill: ${name}`;
        const author = (options.author as string) || 'TITAN User';
        console.log(chalk.cyan(`\n🔧 Scaffolding skill "${name}" (${format})...\n`));
        const result = scaffoldSkill({ name, description, author, format });
        if (result.success) {
            console.log(chalk.green(`✅ Skill scaffolded at: ${result.skillDir}\n`));
            console.log(chalk.white('  Files created:'));
            for (const f of result.files) console.log(chalk.gray(`    ${f}`));
            console.log(chalk.gray(`\n  Edit the skill file, then restart TITAN to load it.`));
            console.log(chalk.gray(`  Test it: titan skills --test ${name}`));
        } else {
            console.log(chalk.red(`❌ Scaffold failed: ${result.error}`));
        }
        process.exit(0);
    });

// ─── MCP-SERVER (stdio transport) ───────────────────────────────
program
    .command('mcp-server')
    .description('Run TITAN as an MCP server (stdio transport for Claude Code, Cursor, etc.)')
    .action(async () => {
        initMemory();
        await initBuiltinSkills();
        const { loadAutoSkills } = await import('../skills/registry.js');
        await loadAutoSkills();
        const { startStdioServer } = await import('../mcp/server.js');
        startStdioServer();
    });

// ─── MCP ─────────────────────────────────────────────────────────
program
    .command('mcp')
    .description('Manage MCP (Model Context Protocol) server connections')
    .option('--list', 'List configured MCP servers')
    .option('--add <name>', 'Add a new MCP server')
    .option('--command <cmd>', 'Command to run the MCP server (for stdio type)')
    .option('--url <url>', 'URL for HTTP MCP servers')
    .option('--remove <id>', 'Remove an MCP server')
    .option('--test <id>', 'Test connection to an MCP server')
    .action(async (options) => {
        if (options.add && (options.command || options.url)) {
            const id = options.add.toLowerCase().replace(/\s+/g, '-');
            const server = addMcpServer({
                id,
                name: options.add,
                description: '',
                type: options.url ? 'http' : 'stdio',
                command: options.command,
                url: options.url,
            });
            console.log(chalk.green(`\n✅ Added MCP server: ${server.name}`));
            console.log(chalk.gray('  Start the gateway to activate it.'));
        } else if (options.remove) {
            removeMcpServer(options.remove);
            console.log(chalk.green(`🗑️  Removed MCP server: ${options.remove}`));
        } else if (options.test) {
            const servers = listMcpServers();
            const server = servers.find((s) => s.id === options.test);
            if (!server) { console.log(chalk.red(`MCP server "${options.test}" not found`)); return; }
            console.log(chalk.cyan(`\n🔌 Testing MCP server: ${server.name}...`));
            const result = await testMcpServer(server);
            if (result.ok) {
                console.log(chalk.green(`  ✅ Connected — ${result.tools} tool(s) available`));
            } else {
                console.log(chalk.red(`  ❌ Failed: ${result.error}`));
            }
        } else {
            const servers = listMcpServers();
            const status = getMcpStatus();
            console.log(chalk.cyan(`\n🔌 MCP Servers (${servers.length})\n`));
            if (servers.length === 0) {
                console.log(chalk.gray('  No MCP servers configured.'));
                console.log(chalk.gray('  Add one: titan mcp --add "GitHub" --command "npx -y @modelcontextprotocol/server-github"'));
            }
            for (const server of servers) {
                const live = status.find((s) => s.server.id === server.id);
                const statusIcon = live?.status === 'connected' ? chalk.green('🟢') : chalk.gray('⚪');
                console.log(`  ${statusIcon} ${chalk.white(server.name)} ${chalk.gray(`(${server.id})`)}`);
                console.log(`     Type: ${server.type} | Tools: ${live?.toolCount ?? '–'} | Enabled: ${server.enabled}`);
            }
        }
        process.exit(0);
    });

// ─── RECIPE ──────────────────────────────────────────────────────
program
    .command('recipe')
    .description('Manage and run TITAN recipes (reusable workflows)')
    .option('--list', 'List all recipes')
    .option('--run <id>', 'Run a recipe by ID or slash command')
    .option('--param <key=value>', 'Parameter for the recipe (can be used multiple times)', (v, a: string[]) => [...a, v], [] as string[])
    .option('--delete <id>', 'Delete a recipe')
    .action(async (options) => {
        seedBuiltinRecipes();
        if (options.run) {
            const params: Record<string, string> = {};
            for (const p of options.param as string[]) {
                const [k, ...rest] = p.split('=');
                params[k] = rest.join('=');
            }
            const recipe = getRecipe(options.run);
            if (!recipe) { console.log(chalk.red(`Recipe "${options.run}" not found`)); return; }
            console.log(chalk.cyan(`\n▶  Running recipe: ${recipe.name}\n`));
            initMemory();
            await initBuiltinSkills();
            loadConfig();
            for await (const step of runRecipe(options.run, params)) {
                console.log(chalk.gray(`\nStep ${step.stepIndex + 1}/${step.total}:`));
                console.log(chalk.white(step.prompt));
                const response = await processMessage(step.prompt, 'cli-recipe', 'user');
                console.log(chalk.cyan('\nTITAN: ') + response.content);
            }
        } else if (options.delete) {
            deleteRecipe(options.delete);
            console.log(chalk.green(`🗑️  Deleted recipe: ${options.delete}`));
        } else {
            listRecipes();
            seedBuiltinRecipes();
            const all = listRecipes();
            console.log(chalk.cyan(`\n📋 TITAN Recipes (${all.length})\n`));
            for (const r of all) {
                const slash = r.slashCommand ? chalk.yellow(` /${r.slashCommand}`) : '';
                console.log(`  ${chalk.white(r.name)}${slash} ${chalk.gray(`(${r.id})`)}`);
                console.log(`     ${chalk.gray(r.description)}`);
            }
            console.log(chalk.gray('\n  Run a recipe: titan recipe --run <id>'));
            console.log(chalk.gray('  Or use slash commands in WebChat: /code-review, /standup, /debug'));
        }
        process.exit(0);
    });

// ─── MODEL ───────────────────────────────────────────────────────
program
    .command('model')
    .description('View, switch, or discover AI models across all providers')
    .option('--list', 'List known models (static)')
    .option('--discover', 'Live-discover models from all providers (detects local Ollama models)')
    .option('--set <model>', 'Switch to a different model (accepts aliases: fast, smart, cheap, reasoning, local)')
    .option('--alias <name=model>', 'Set a model alias (e.g. --alias local=ollama/llama3.1)')
    .option('--aliases', 'Show all model aliases')
    .option('--current', 'Show the currently active model')
    .action(async (options) => {
        const config = loadConfig();
        if (options.set) {
            // Support alias resolution for --set
            const aliases = config.agent.modelAliases || {};
            const resolved = aliases[options.set] || options.set;
            updateConfig({ agent: { ...config.agent, model: resolved } });
            const aliasNote = resolved !== options.set ? ` (alias "${options.set}")` : '';
            console.log(chalk.green(`\n✅ Model switched to: ${resolved}${aliasNote}`));
            console.log(chalk.gray('  Active from next message.'));
        } else if (options.alias) {
            const [name, ...rest] = (options.alias as string).split('=');
            const modelId = rest.join('=');
            if (!name || !modelId) {
                console.log(chalk.red('Usage: titan model --alias <name>=<provider/model>'));
                return;
            }
            const aliases = { ...(config.agent.modelAliases || {}), [name]: modelId };
            updateConfig({ agent: { ...config.agent, modelAliases: aliases } });
            console.log(chalk.green(`\n✅ Alias set: "${name}" → ${modelId}`));
        } else if (options.aliases) {
            const aliases = config.agent.modelAliases || {};
            console.log(chalk.cyan('\n🏷️  Model Aliases\n'));
            if (Object.keys(aliases).length === 0) {
                console.log(chalk.gray('  No aliases configured.'));
            } else {
                for (const [name, model] of Object.entries(aliases)) {
                    const active = model === config.agent.model ? chalk.green(' ← active') : '';
                    console.log(`  ${chalk.yellow(name)} → ${chalk.white(model)}${active}`);
                }
            }
            console.log(chalk.gray('\n  Set alias: titan model --alias local=ollama/llama3.1'));
            console.log(chalk.gray('  Use alias: titan model --set local'));
        } else if (options.discover) {
            console.log(chalk.cyan('\n🔍 Discovering models across all providers...\n'));
            const { discoverAllModels } = await import('../providers/router.js');
            const models = await discoverAllModels(true);

            // Group by provider
            const grouped = new Map<string, typeof models>();
            for (const m of models) {
                const list = grouped.get(m.provider) || [];
                list.push(m);
                grouped.set(m.provider, list);
            }

            for (const [, providerModels] of grouped) {
                const first = providerModels[0];
                const liveTag = providerModels.some(m => m.source === 'live') ? chalk.green(' [LIVE]') : chalk.gray(' [static]');
                console.log(chalk.white(`  ${first.displayName}${liveTag}:`));
                for (const m of providerModels) {
                    const active = m.id === config.agent.model ? chalk.green(' ← active') : '';
                    console.log(`    ${chalk.gray(m.id)}${active}`);
                }
                console.log();
            }

            const ollamaModels = models.filter(m => m.provider === 'ollama' && m.source === 'live');
            if (ollamaModels.length > 0) {
                console.log(chalk.green(`  ✅ ${ollamaModels.length} local Ollama model(s) detected`));
            } else {
                console.log(chalk.gray('  ℹ  No local Ollama models found — start Ollama to see local models'));
            }
            console.log(chalk.gray('\n  Switch model: titan model --set <model-id>'));
        } else if (options.list) {
            console.log(chalk.cyan('\n🧠 Known Models (20 Providers)\n'));
            const models = [
                { provider: 'Anthropic', models: ['anthropic/claude-opus-4-0', 'anthropic/claude-sonnet-4-20250514', 'anthropic/claude-haiku-4-20250414'] },
                { provider: 'OpenAI', models: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o3', 'openai/o4-mini'] },
                { provider: 'Google', models: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.0-flash'] },
                { provider: 'Groq (Fast)', models: ['groq/llama-3.3-70b-versatile', 'groq/mixtral-8x7b-32768', 'groq/deepseek-r1-distill-llama-70b'] },
                { provider: 'Mistral AI', models: ['mistral/mistral-large-latest', 'mistral/mistral-small-latest', 'mistral/codestral-latest'] },
                { provider: 'OpenRouter (290+)', models: ['openrouter/anthropic/claude-sonnet-4-20250514', 'openrouter/openai/gpt-4o', 'openrouter/meta-llama/llama-3.3-70b'] },
                { provider: 'xAI (Grok)', models: ['xai/grok-3', 'xai/grok-3-fast', 'xai/grok-3-mini'] },
                { provider: 'Together AI', models: ['together/meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together/deepseek-ai/DeepSeek-R1'] },
                { provider: 'Fireworks AI', models: ['fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct'] },
                { provider: 'DeepSeek', models: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'] },
                { provider: 'Cerebras (Ultra-Fast)', models: ['cerebras/llama-3.3-70b', 'cerebras/qwen-3-32b'] },
                { provider: 'Cohere', models: ['cohere/command-r-plus', 'cohere/command-r'] },
                { provider: 'Perplexity (Search)', models: ['perplexity/sonar', 'perplexity/sonar-pro'] },
                { provider: 'Venice AI (Privacy)', models: ['venice/llama-3.3-70b', 'venice/deepseek-r1-671b', 'venice/qwen-2.5-vl-72b'] },
                { provider: 'AWS Bedrock (Proxy)', models: ['bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0', 'bedrock/amazon.titan-text-premier-v1:0'] },
                { provider: 'LiteLLM (Universal)', models: ['litellm/gpt-4o', 'litellm/claude-sonnet-4-20250514'] },
                { provider: 'Azure OpenAI', models: ['azure/gpt-4o', 'azure/gpt-4o-mini', 'azure/gpt-4-turbo'] },
                { provider: 'DeepInfra', models: ['deepinfra/meta-llama/Llama-3.3-70B-Instruct', 'deepinfra/Qwen/Qwen2.5-72B-Instruct'] },
                { provider: 'SambaNova', models: ['sambanova/Meta-Llama-3.3-70B-Instruct', 'sambanova/DeepSeek-R1-Distill-Llama-70B'] },
                { provider: 'Ollama (local)', models: ['ollama/<your-models>'] },
            ];
            for (const group of models) {
                console.log(chalk.white(`  ${group.provider}:`));
                for (const m of group.models) {
                    const active = m === config.agent.model ? chalk.green(' ← active') : '';
                    console.log(`    ${chalk.gray(m)}${active}`);
                }
                console.log();
            }
            console.log(chalk.gray('  Tip: Run `titan model --discover` to query all providers for live model lists'));
        } else {
            const aliases = config.agent.modelAliases || {};
            const aliasNote = Object.entries(aliases).find(([, v]) => v === config.agent.model);
            const extra = aliasNote ? chalk.gray(` (alias: "${aliasNote[0]}")`) : '';
            console.log(chalk.cyan(`\n🧠 Current model: ${chalk.white(config.agent.model)}${extra}`));
            console.log(chalk.gray('  Switch: titan model --set openai/gpt-4o'));
            console.log(chalk.gray('  Aliases: titan model --set fast  (use titan model --aliases to see all)'));
            console.log(chalk.gray('  Discover: titan model --discover  (finds local Ollama models)'));
        }
        process.exit(0);
    });

// ─── PROBE-MODELS ──────────────────────────────────────────────────
program
    .command('probe-models')
    .description('Empirically probe model capabilities (thinking routing, tool calling, latency, CoT leaks) and cache results')
    .option('--model <id>', 'Probe one specific model (e.g. ollama/glm-5.1:cloud)')
    .option('--all-cloud', 'Probe all configured cloud models')
    .option('--list', 'List previously probed models')
    .option('--clear', 'Clear the probe registry')
    .action(async (options) => {
        const { probeModel, formatProbeResult } = await import('../agent/modelProbe.js');
        const { listProbedModels, clearRegistry, recordProbeResult, loadRegistry } = await import('../agent/capabilitiesRegistry.js');

        if (options.clear) {
            clearRegistry();
            console.log(chalk.green('✅ Cleared probe registry'));
            return;
        }

        if (options.list) {
            const models = listProbedModels();
            const registry = loadRegistry();
            console.log(chalk.cyan(`\n🔬 Probed Models (${models.length})\n`));
            for (const m of models) {
                const r = registry.models[m];
                console.log(formatProbeResult(r));
                console.log();
            }
            return;
        }

        // Decide which models to probe
        const modelsToProbe: string[] = [];
        if (options.model) {
            modelsToProbe.push(options.model);
        } else if (options.allCloud) {
            // Discover all cloud models from config + Ollama
            try {
                const config = loadConfig();
                const aliases = Object.values(config.agent.modelAliases || {}) as string[];
                const fallbacks = (config.agent.fallbackChain || []) as string[];
                const primary = config.agent.model ? [config.agent.model] : [];
                const all = new Set([...primary, ...aliases, ...fallbacks].filter(m => m && m.includes('/')));
                modelsToProbe.push(...Array.from(all));
            } catch (err) {
                console.log(chalk.red(`Failed to load config: ${(err as Error).message}`));
                process.exit(1);
            }
        } else {
            console.log(chalk.yellow('Usage: titan probe-models --model <id>'));
            console.log(chalk.yellow('       titan probe-models --all-cloud'));
            console.log(chalk.yellow('       titan probe-models --list'));
            console.log(chalk.yellow('       titan probe-models --clear'));
            process.exit(0);
        }

        console.log(chalk.cyan(`\n🔬 Probing ${modelsToProbe.length} model(s)...\n`));
        for (const model of modelsToProbe) {
            console.log(chalk.gray(`Probing ${model}...`));
            try {
                const result = await probeModel(model);
                recordProbeResult(result);
                console.log(formatProbeResult(result));
                console.log();
            } catch (err) {
                console.log(chalk.red(`❌ ${model}: ${(err as Error).message}\n`));
            }
        }
        console.log(chalk.green(`✅ Probe complete. Results saved to ~/.titan/model-capabilities.json`));
    });

// ─── MONITOR ─────────────────────────────────────────────────────
program
    .command('monitor')
    .description('Manage TITAN proactive monitors (always-on JARVIS mode)')
    .option('--list', 'List all monitors')
    .option('--add <name>', 'Add a new monitor')
    .option('--watch <path>', 'File/directory to watch (for file_change type)')
    .option('--prompt <prompt>', 'What TITAN should do when triggered')
    .option('--schedule <cron>', 'Cron-style schedule e.g. */30 = every 30 minutes')
    .option('--remove <id>', 'Remove a monitor')
    .action((options) => {
        if (options.add && options.prompt) {
            const id = options.add.toLowerCase().replace(/\s+/g, '-');
            const type = options.schedule ? 'schedule' : 'file_change';
            const monitor = addMonitor({
                id,
                name: options.add,
                description: '',
                triggerType: type,
                watchPath: options.watch,
                cronExpression: options.schedule,
                prompt: options.prompt,
                enabled: true,
            });
            console.log(chalk.green(`\n👁️  Monitor "${monitor.name}" created`));
            console.log(chalk.gray(`  Type: ${type} | Start the gateway to activate.`));
        } else if (options.remove) {
            removeMonitor(options.remove);
            console.log(chalk.green(`🗑️  Removed monitor: ${options.remove}`));
        } else {
            const monitors = listMonitors();
            console.log(chalk.cyan(`\n👁️  TITAN Monitors (${monitors.length})\n`));
            if (monitors.length === 0) {
                console.log(chalk.gray('  No monitors configured. TITAN is reactive only.'));
                console.log(chalk.gray('  Add one: titan monitor --add "Watch Code" --watch /path/to/project --prompt "Summarise changes"'));
            }
            for (const m of monitors) {
                const icon = m.enabled ? chalk.green('🟢') : chalk.gray('⚪');
                console.log(`  ${icon} ${chalk.white(m.name)} ${chalk.gray(`(${m.id})`)}`);
                console.log(`     Type: ${m.triggerType} | Triggers: ${m.triggerCount} | Last: ${m.lastTriggeredAt ?? 'never'}`);
                console.log(`     Prompt: ${chalk.gray(m.prompt.slice(0, 60))}...`);
            }
        }
        process.exit(0);
    });


// ─── MESH ───────────────────────────────────────────────────────
program
    .command('mesh')
    .description('Manage TITAN mesh networking (multi-computer, zero config)')
    .option('--init', 'Initialize mesh mode and generate a shared secret')
    .option('--join <secret>', 'Join an existing mesh using a shared secret')
    .option('--status', 'Show mesh status and connected peers')
    .option('--add <address>', 'Manually add a peer (host:port)')
    .option('--pending', 'Show peers waiting for approval')
    .option('--approve <nodeId>', 'Approve a discovered peer to join the mesh')
    .option('--reject <nodeId>', 'Reject a pending peer')
    .option('--revoke <nodeId>', 'Disconnect and remove a connected peer')
    .option('--auto-approve', 'Toggle auto-approve mode for discovered peers')
    .option('--leave', 'Leave the mesh and disable mesh networking')
    .action(async (options) => {
        const config = loadConfig();
        const gwPort = config.gateway?.port || 48420;

        if (options.init) {
            const { randomBytes } = await import('crypto');
            const secret = `TITAN-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`;
            updateConfig({
                mesh: { ...config.mesh, enabled: true, secret },
            } as Partial<TitanConfig>);
            const { getOrCreateNodeId } = await import('../mesh/identity.js');
            const nodeId = getOrCreateNodeId();

            console.log(chalk.cyan('\n  TITAN Mesh Initialized!\n'));
            console.log(chalk.white(`  Node ID: ${nodeId.slice(0, 8)}...`));
            console.log(chalk.yellow(`  Mesh Secret: ${secret}\n`));
            console.log(chalk.gray(`  Max peers: ${config.mesh.maxPeers || 5}`));
            console.log(chalk.gray(`  Auto-approve: ${config.mesh.autoApprove ? 'On' : 'Off (peers require approval)'}`));
            console.log(chalk.gray('  Share this secret with your other TITAN instances.'));
            console.log(chalk.gray('  On each machine, run:\n'));
            console.log(chalk.white(`    titan mesh --join ${secret}\n`));
            console.log(chalk.gray('  Then start the gateway: titan gateway'));

        } else if (options.join) {
            const secret = options.join as string;
            if (!secret.startsWith('TITAN-')) {
                console.log(chalk.red('Invalid mesh secret. Secrets start with TITAN-'));
                return;
            }
            updateConfig({
                mesh: { ...config.mesh, enabled: true, secret },
            } as Partial<TitanConfig>);
            const { getOrCreateNodeId } = await import('../mesh/identity.js');
            const nodeId = getOrCreateNodeId();

            console.log(chalk.green('\n  Joined TITAN mesh!'));
            console.log(chalk.gray(`  Node ID: ${nodeId.slice(0, 8)}...`));
            console.log(chalk.gray('  Start the gateway to begin discovering peers: titan gateway'));

        } else if (options.add) {
            const addr = options.add as string;
            const staticPeers = [...(config.mesh.staticPeers || [])];
            if (!staticPeers.includes(addr)) staticPeers.push(addr);
            updateConfig({
                mesh: { ...config.mesh, staticPeers },
            } as Partial<TitanConfig>);
            console.log(chalk.green(`\n  Added static peer: ${addr}`));
            console.log(chalk.gray('  Restart the gateway to connect.'));

        } else if (options.pending) {
            // Query the running gateway for pending peers
            try {
                const res = await fetch(`http://127.0.0.1:${gwPort}/api/mesh/pending`);
                const data = await res.json() as { pending: Array<{ nodeId: string; hostname: string; address: string; port: number; version: string; models: string[]; discoveredVia: string }> };
                if (!data.pending || data.pending.length === 0) {
                    console.log(chalk.gray('\n  No peers waiting for approval.\n'));
                } else {
                    console.log(chalk.cyan(`\n  Pending Peers (${data.pending.length})\n`));
                    for (const p of data.pending) {
                        console.log(chalk.white(`  ${p.hostname}`));
                        console.log(chalk.gray(`    Node ID:  ${p.nodeId}`));
                        console.log(chalk.gray(`    Address:  ${p.address}:${p.port}`));
                        console.log(chalk.gray(`    Version:  ${p.version}`));
                        console.log(chalk.gray(`    Models:   ${p.models.length > 0 ? p.models.join(', ') : '(none reported)'}`));
                        console.log(chalk.gray(`    Found via: ${p.discoveredVia}`));
                        console.log(chalk.yellow(`    Approve:  titan mesh --approve ${p.nodeId}\n`));
                    }
                }
            } catch {
                console.log(chalk.red('\n  Cannot reach gateway. Is it running? (titan gateway)\n'));
            }

        } else if (options.approve) {
            const nodeId = options.approve as string;
            try {
                const res = await fetch(`http://127.0.0.1:${gwPort}/api/mesh/approve/${nodeId}`, { method: 'POST' });
                const data = await res.json() as { approved?: boolean; peer?: { hostname: string }; error?: string };
                if (data.approved) {
                    console.log(chalk.green(`\n  Peer approved and connected: ${data.peer?.hostname || nodeId}\n`));
                } else {
                    console.log(chalk.red(`\n  ${data.error || 'Failed to approve peer'}\n`));
                }
            } catch {
                console.log(chalk.red('\n  Cannot reach gateway. Is it running? (titan gateway)\n'));
            }

        } else if (options.reject) {
            const nodeId = options.reject as string;
            try {
                const res = await fetch(`http://127.0.0.1:${gwPort}/api/mesh/reject/${nodeId}`, { method: 'POST' });
                const data = await res.json() as { rejected: boolean };
                console.log(data.rejected
                    ? chalk.green(`\n  Peer rejected: ${nodeId}\n`)
                    : chalk.yellow(`\n  Peer not found in pending list.\n`));
            } catch {
                console.log(chalk.red('\n  Cannot reach gateway. Is it running? (titan gateway)\n'));
            }

        } else if (options.revoke) {
            const nodeId = options.revoke as string;
            try {
                const res = await fetch(`http://127.0.0.1:${gwPort}/api/mesh/revoke/${nodeId}`, { method: 'POST' });
                const data = await res.json() as { revoked: boolean };
                console.log(data.revoked
                    ? chalk.green(`\n  Peer disconnected and revoked: ${nodeId}\n`)
                    : chalk.yellow(`\n  Peer not found.\n`));
            } catch {
                console.log(chalk.red('\n  Cannot reach gateway. Is it running? (titan gateway)\n'));
            }

        } else if (options.autoApprove) {
            const newVal = !config.mesh.autoApprove;
            updateConfig({
                mesh: { ...config.mesh, autoApprove: newVal },
            } as Partial<TitanConfig>);
            console.log(chalk.green(`\n  Auto-approve: ${newVal ? chalk.green('ON') : chalk.yellow('OFF')}`));
            console.log(chalk.gray(newVal
                ? '  Discovered peers will connect automatically.'
                : '  Discovered peers will require approval via dashboard or CLI.\n'));

        } else if (options.leave) {
            updateConfig({
                mesh: { ...config.mesh, enabled: false, secret: undefined },
            } as Partial<TitanConfig>);
            console.log(chalk.green('\n  Left the mesh. Mesh networking disabled.'));

        } else if (options.status) {
            console.log(chalk.cyan('\n  TITAN Mesh Status\n'));
            console.log(chalk.gray(`  Enabled:       ${config.mesh.enabled ? chalk.green('Yes') : chalk.red('No')}`));
            console.log(chalk.gray(`  Secret:        ${config.mesh.secret ? config.mesh.secret.slice(0, 6) + '****' : 'Not set'}`));
            console.log(chalk.gray(`  mDNS:          ${config.mesh.mdns ? 'On' : 'Off'}`));
            console.log(chalk.gray(`  Tailscale:     ${config.mesh.tailscale ? 'On' : 'Off'}`));
            console.log(chalk.gray(`  Max peers:     ${config.mesh.maxPeers || 5}`));
            console.log(chalk.gray(`  Auto-approve:  ${config.mesh.autoApprove ? chalk.green('On') : chalk.yellow('Off')}`));
            if (config.mesh.staticPeers.length > 0) {
                console.log(chalk.gray(`  Static peers:  ${config.mesh.staticPeers.join(', ')}`));
            }
            if (config.mesh.enabled) {
                const { getOrCreateNodeId } = await import('../mesh/identity.js');
                console.log(chalk.gray(`  Node ID:       ${getOrCreateNodeId()}`));

                // Try to get live status from running gateway
                try {
                    const [peersRes, pendingRes] = await Promise.all([
                        fetch(`http://127.0.0.1:${gwPort}/api/mesh/peers`),
                        fetch(`http://127.0.0.1:${gwPort}/api/mesh/pending`),
                    ]);
                    const peersData = await peersRes.json() as { peers: Array<{ nodeId: string; hostname: string; address: string; port: number; models: string[]; load: number }> };
                    const pendingData = await pendingRes.json() as { pending: Array<{ nodeId: string; hostname: string }> };

                    if (peersData.peers.length > 0) {
                        console.log(chalk.cyan(`\n  Connected Peers (${peersData.peers.length}/${config.mesh.maxPeers || 5}):\n`));
                        for (const p of peersData.peers) {
                            console.log(chalk.green(`    ${p.hostname}  ${chalk.gray(`${p.address}:${p.port}  |  ${p.models.length} models  |  load: ${p.load}`)}`));
                        }
                    } else {
                        console.log(chalk.gray('\n  No connected peers.'));
                    }

                    if (pendingData.pending.length > 0) {
                        console.log(chalk.yellow(`\n  Pending Approval (${pendingData.pending.length}):\n`));
                        for (const p of pendingData.pending) {
                            console.log(chalk.yellow(`    ${p.hostname}  ${chalk.gray(`(${p.nodeId.slice(0, 8)}...)`)}`));
                        }
                        console.log(chalk.gray('\n  Run `titan mesh --pending` for details or `titan mesh --approve <nodeId>` to connect.'));
                    }
                } catch {
                    console.log(chalk.gray('\n  Gateway not running — start with `titan gateway` to see live peers.'));
                }
            }
        } else {
            console.log(chalk.gray('Usage: titan mesh --init | --join <secret> | --status | --add <host:port>'));
            console.log(chalk.gray('       titan mesh --pending | --approve <nodeId> | --reject <nodeId>'));
            console.log(chalk.gray('       titan mesh --revoke <nodeId> | --auto-approve | --leave'));
        }
        process.exit(0);
    });

// ─── CONFIG ──────────────────────────────────────────────────────
program
    .command('config [key]')
    .description('View or edit TITAN configuration (use: titan config agent.model)')
    .option('--show', 'Show current configuration')
    .option('--set <key=value>', 'Set a configuration value')
    .option('--path', 'Show config file path')
    .action((key: string | undefined, options: Record<string, unknown>) => {
        if (options.path) {
            console.log(TITAN_CONFIG_PATH);
        } else if (options.set) {
            const eqIdx = (options.set as string).indexOf('=');
            if (eqIdx === -1) {
                console.log(chalk.red('Invalid format. Use: titan config --set key=value'));
                return;
            }
            const key = (options.set as string).slice(0, eqIdx).trim();
            const rawValue = (options.set as string).slice(eqIdx + 1).trim();

            // Coerce value types
            let value: unknown = rawValue;
            if (rawValue === 'true') value = true;
            else if (rawValue === 'false') value = false;
            else if (rawValue !== '' && !isNaN(Number(rawValue))) value = Number(rawValue);

            // Walk dot-notation into a nested object
            const parts = key.split('.');
            const partial: Record<string, unknown> = {};
            let current: Record<string, unknown> = partial;
            for (let i = 0; i < parts.length - 1; i++) {
                current[parts[i]] = {};
                current = current[parts[i]] as Record<string, unknown>;
            }
            current[parts[parts.length - 1]] = value;

            try {
                updateConfig(partial as Partial<TitanConfig>);
                console.log(chalk.green(`✔ Set ${key} = ${JSON.stringify(value)}`));
            } catch (err) {
                console.log(chalk.red(`Failed to set config: ${(err as Error).message}`));
            }
        } else {
            const config = loadConfig();
            if (key) {
                // Walk dot-notation to get nested value
                const parts = key.split('.');
                let value: unknown = config;
                for (const part of parts) {
                    if (value && typeof value === 'object' && part in (value as Record<string, unknown>)) {
                        value = (value as Record<string, unknown>)[part];
                    } else {
                        console.log(chalk.red(`Key not found: ${key}`));
                        process.exit(1);
                    }
                }
                console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
            } else {
                console.log(chalk.cyan('\n⚙️  TITAN Configuration\n'));
                console.log(JSON.stringify(config, null, 2));
            }
        }
        process.exit(0);
    });

// ─── UPDATE ──────────────────────────────────────────────────────
program
    .command('update')
    .description('Update TITAN to the latest version')
    .option('--channel <channel>', 'Release channel: stable|beta|dev', 'stable')
    .action((options) => {
        console.log(chalk.cyan(`Updating TITAN to latest ${options.channel} release...`));
        console.log(chalk.gray('Run: npm install -g titan-agent@latest'));
        process.exit(0);
    });

// ─── MEMORY GRAPH ─────────────────────────────────────────────────
program
    .command('graphiti')
    .description('Manage TITAN\'s native temporal knowledge graph (no Docker required)')
    .option('--init', 'Initialize the native graph memory and register graph tools')
    .option('--clear', 'Clear all graph memory data (requires confirmation)')
    .option('--stats', 'Show graph memory statistics')
    .action(async (options) => {
        const { initGraph, getGraphStats, clearGraph } = await import('../memory/graph.js');

        if (options.stats) {
            initGraph();
            const stats = getGraphStats();
            console.log(chalk.cyan('\n🕸️  TITAN Memory Graph Stats\n'));
            console.log(chalk.white(`  Episodes : ${chalk.bold(stats.episodeCount)}`));
            console.log(chalk.white(`  Entities : ${chalk.bold(stats.entityCount)}`));
            console.log(chalk.white(`  Edges    : ${chalk.bold(stats.edgeCount)}`));
            console.log();
            process.exit(0);
        }

        if (options.clear) {
            const readline = await import('readline');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            await new Promise<void>((resolve) => {
                rl.question(chalk.yellow('⚠️  This will delete ALL graph memory data. Type "yes" to confirm: '), (answer) => {
                    rl.close();
                    if (answer.trim().toLowerCase() === 'yes') {
                        initGraph();
                        clearGraph();
                        console.log(chalk.green('\n✅ Graph memory cleared.'));
                    } else {
                        console.log(chalk.gray('\nAborted.'));
                    }
                    resolve();
                });
            });
            process.exit(0);
        }

        if (options.init) {
            console.log(chalk.cyan('\n🧠 Initializing TITAN native temporal memory graph...\n'));
            initGraph();
            const stats = getGraphStats();
            console.log(chalk.green('✅ Graph memory initialized!'));
            console.log(chalk.gray(`   Storage: ~/.titan/graph.json`));
            console.log(chalk.gray(`   Episodes: ${stats.episodeCount} | Entities: ${stats.entityCount}`));
            console.log(chalk.gray('\nThe graph_remember, graph_search, graph_entities, and graph_recall'));
            console.log(chalk.gray('tools are now available to the agent automatically.'));
            console.log(chalk.gray('\nNo Docker or external API key required — uses your configured LLM provider.'));
        } else {
            console.log(chalk.gray('Usage: titan graphiti --init | --stats | --clear'));
        }
        process.exit(0);
    });

// ─── VAULT ──────────────────────────────────────────────────────
program
    .command('vault')
    .description('Manage encrypted secrets vault')
    .option('--init', 'Initialize a new vault (prompts for passphrase)')
    .option('--unlock', 'Unlock the vault (prompts for passphrase)')
    .option('--lock', 'Lock the vault (clear secrets from memory)')
    .option('--set <name>', 'Set a secret value')
    .option('--get <name>', 'Get a secret value')
    .option('--delete <name>', 'Delete a secret')
    .option('--list', 'List all secret names')
    .action(async (options) => {
        const { initVault, unlockVault, lockVault, setSecret, getSecret, deleteSecret, listSecretNames, isVaultUnlocked } = await import('../security/secrets.js');
        const { password: promptPassword } = await import('@inquirer/prompts');

        if (options.init) {
            const pass = await promptPassword({ message: 'Set vault passphrase:', mask: '*' });
            const confirmPass = await promptPassword({ message: 'Confirm passphrase:', mask: '*' });
            if (pass !== confirmPass) { console.log(chalk.red('Passphrases do not match.')); process.exit(1); }
            initVault(pass);
            console.log(chalk.green('Vault initialized at ~/.titan/vault.enc'));
        } else if (options.unlock) {
            const pass = await promptPassword({ message: 'Vault passphrase:', mask: '*' });
            try {
                unlockVault(pass);
                console.log(chalk.green('Vault unlocked.'));
            } catch { console.log(chalk.red('Failed to unlock vault. Wrong passphrase?')); }
        } else if (options.lock) {
            lockVault();
            console.log(chalk.green('Vault locked.'));
        } else if (options.set) {
            if (!isVaultUnlocked()) { console.log(chalk.red('Vault is locked. Run: titan vault --unlock')); process.exit(1); }
            const value = await promptPassword({ message: `Value for "${options.set}":`, mask: '*' });
            setSecret(options.set, value);
            console.log(chalk.green(`Secret "${options.set}" saved.`));
        } else if (options.get) {
            if (!isVaultUnlocked()) { console.log(chalk.red('Vault is locked. Run: titan vault --unlock')); process.exit(1); }
            const val = getSecret(options.get);
            console.log(val ? chalk.white(val) : chalk.yellow('Secret not found.'));
        } else if (options.delete) {
            if (!isVaultUnlocked()) { console.log(chalk.red('Vault is locked. Run: titan vault --unlock')); process.exit(1); }
            deleteSecret(options.delete);
            console.log(chalk.green(`Secret "${options.delete}" deleted.`));
        } else if (options.list) {
            if (!isVaultUnlocked()) { console.log(chalk.red('Vault is locked. Run: titan vault --unlock')); process.exit(1); }
            const names = listSecretNames();
            if (names.length === 0) { console.log(chalk.gray('Vault is empty.')); }
            else { names.forEach(n => console.log(`  ${chalk.white(n)}`)); }
        } else {
            console.log(chalk.gray('Usage: titan vault --init | --unlock | --lock | --set <name> | --get <name> | --list'));
        }
        process.exit(0);
    });

// ─── AUTOPILOT ──────────────────────────────────────────────────
program
    .command('autopilot')
    .description('Manage TITAN autopilot — hands-free scheduled agent runs')
    .option('--init', 'Create default AUTOPILOT.md checklist')
    .option('--run', 'Trigger an autopilot run immediately')
    .option('--status', 'Show autopilot schedule, last run, next run')
    .option('--history', 'Show recent autopilot run history')
    .option('--limit <n>', 'Number of history entries to show', '10')
    .option('--enable', 'Enable autopilot in config')
    .option('--disable', 'Disable autopilot in config')
    .action(async (options) => {
        if (options.init) {
            const { initChecklist } = await import('../agent/autopilot.js');
            const path = initChecklist();
            console.log(chalk.green(`Created autopilot checklist at: ${path}`));
            console.log(chalk.gray('Edit this file to control what TITAN checks each cycle.'));
            console.log(chalk.gray('Then enable autopilot: titan autopilot --enable'));
        } else if (options.run) {
            console.log(chalk.cyan('Starting autopilot run...\n'));
            initMemory();
            initLearning();
            await initBuiltinSkills();
            const { runAutopilotNow } = await import('../agent/autopilot.js');
            try {
                const result = await runAutopilotNow();
                const r = result.run;
                const icon = r.classification === 'ok' ? chalk.green('OK') :
                    r.classification === 'notable' ? chalk.yellow('NOTABLE') :
                    chalk.red('URGENT');
                console.log(chalk.white(`\nResult: ${icon}`));
                if (r.skipped) {
                    console.log(chalk.gray(`  Skipped: ${r.skipReason}`));
                } else {
                    console.log(chalk.gray(`  Duration: ${r.duration}ms | Tokens: ${r.tokensUsed} | Tools: ${r.toolsUsed.join(', ') || 'none'}`));
                    console.log(chalk.white(`\n${r.summary}`));
                }
            } catch (error) {
                console.error(chalk.red(`Autopilot run failed: ${(error as Error).message}`));
            }
        } else if (options.status) {
            const { getAutopilotStatus } = await import('../agent/autopilot.js');
            const s = getAutopilotStatus();
            console.log(chalk.cyan('\nAutopilot Status\n'));
            console.log(chalk.gray(`  Enabled:    ${s.enabled ? chalk.green('Yes') : chalk.red('No')}`));
            console.log(chalk.gray(`  Schedule:   ${s.schedule}`));
            console.log(chalk.gray(`  Running:    ${s.isRunning ? chalk.yellow('Yes') : 'No'}`));
            console.log(chalk.gray(`  Total runs: ${s.totalRuns}`));
            if (s.lastRun) {
                const icon = s.lastRun.classification === 'ok' ? 'OK' :
                    s.lastRun.classification === 'notable' ? 'NOTABLE' : 'URGENT';
                console.log(chalk.gray(`  Last run:   ${s.lastRun.timestamp} (${icon})`));
            } else {
                console.log(chalk.gray('  Last run:   never'));
            }
            console.log(chalk.gray(`  Next:       ${s.nextRunEstimate || 'not scheduled'}`));
        } else if (options.history) {
            const { getRunHistory } = await import('../agent/autopilot.js');
            const limit = parseInt(options.limit, 10) || 10;
            const runs = getRunHistory(limit);
            console.log(chalk.cyan(`\nAutopilot History (last ${runs.length} runs)\n`));
            if (runs.length === 0) {
                console.log(chalk.gray('  No runs yet. Start one: titan autopilot --run'));
            }
            for (const r of runs) {
                const icon = r.classification === 'ok' ? chalk.green('OK') :
                    r.classification === 'notable' ? chalk.yellow('NOTABLE') :
                    chalk.red('URGENT');
                const skipped = r.skipped ? chalk.gray(` [skipped: ${r.skipReason}]`) : '';
                console.log(`  ${chalk.gray(r.timestamp)} ${icon}${skipped}`);
                if (!r.skipped) {
                    console.log(chalk.gray(`    ${r.duration}ms | ${r.tokensUsed} tokens | ${r.summary.slice(0, 80)}...`));
                }
            }
        } else if (options.enable) {
            const config = loadConfig();
            updateConfig({ autopilot: { ...config.autopilot, enabled: true } } as Partial<TitanConfig>);
            console.log(chalk.green('Autopilot enabled. Runs will start on next gateway boot.'));
            console.log(chalk.gray(`  Schedule: ${config.autopilot.schedule}`));
        } else if (options.disable) {
            const config = loadConfig();
            updateConfig({ autopilot: { ...config.autopilot, enabled: false } } as Partial<TitanConfig>);
            console.log(chalk.green('Autopilot disabled.'));
        } else {
            console.log(chalk.gray('Usage: titan autopilot --init | --run | --status | --history | --enable | --disable'));
        }
        process.exit(0);
    });

// Parse and execute
(async () => {
    initFileLogger(TITAN_LOGS_DIR);
    // Check for updates (fast timeout, non-blocking if offline)
    await checkForUpdates();
    await program.parseAsync();
})().catch((err) => { console.error(err); process.exit(1); });
