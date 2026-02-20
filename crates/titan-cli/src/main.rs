use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use reqwest::blocking::Client;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::thread;
use std::time::{Duration, Instant};
use titan_common::config::{AutonomyMode, ModelProvider, TitanConfig};
use titan_common::{APP_NAME, logging};
use titan_comms::{ChannelKind, channel_send, channel_status};
use titan_core::{
    Goal, GoalAttemptBehavior, GoalExecutionConfig, GoalJob, GoalStatus, Runtime, SubagentConfig,
    SubagentOrchestrator, SubagentTask, SubmitOutcome, TraceEvent,
};
use titan_discord::DiscordGateway;
use titan_memory::MemoryStore;
use titan_skills::{SkillPackage, SkillRuntime};
use titan_tools::{PolicyEngine, ToolExecutionContext, ToolExecutor, ToolRegistry};
use titan_web as web_runtime;

#[derive(Debug, Parser)]
#[command(name = "titan", about = "TITAN agent platform CLI", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate local setup and generate default config if missing.
    Doctor,
    /// Guided first-run setup (workspace, mode, channels, model selection).
    Onboard,
    /// Goal operations.
    Goal {
        #[command(subcommand)]
        command: GoalCommand,
    },
    /// Tool execution (with policy and approvals).
    Tool {
        #[command(subcommand)]
        command: ToolCommand,
    },
    /// Approval queue operations.
    Approval {
        #[command(subcommand)]
        command: ApprovalCommand,
    },
    /// Memory operations.
    Memory {
        #[command(subcommand)]
        command: MemoryCommand,
    },
    /// Discord integration commands.
    Discord {
        #[command(subcommand)]
        command: DiscordCommand,
    },
    /// Unified communication channels.
    Comm {
        #[command(subcommand)]
        command: CommCommand,
    },
    /// LLM model configuration commands.
    Model {
        #[command(subcommand)]
        command: ModelCommand,
    },
    /// Skill runtime commands.
    Skill {
        #[command(subcommand)]
        command: SkillCommand,
    },
    /// Web dashboard commands.
    Web {
        #[command(subcommand)]
        command: WebCommand,
    },
    /// Multi-agent orchestration commands.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
}

#[derive(Debug, Subcommand)]
enum GoalCommand {
    /// Submit a goal and execute a baseline lifecycle.
    Submit {
        description: String,
        #[arg(long)]
        dedupe_key: Option<String>,
        #[arg(long, default_value = "success")]
        simulate: String,
        #[arg(long, default_value_t = 1)]
        max_retries: u8,
        #[arg(long, default_value_t = 10_000)]
        timeout_ms: u64,
    },
    /// Show goal details and persisted traces.
    Show { goal_id: String },
    /// Cancel a goal by id.
    Cancel { goal_id: String },
}

#[derive(Debug, Subcommand)]
enum ToolCommand {
    /// Run a tool by name.
    Run {
        tool_name: String,
        #[arg(long)]
        input: Option<String>,
        #[arg(long, default_value_t = 300_000)]
        approval_ttl_ms: u64,
    },
}

#[derive(Debug, Subcommand)]
enum ApprovalCommand {
    /// List pending approvals.
    List,
    /// Show one approval request.
    Show { approval_id: String },
    /// Wait for a pending request to resolve.
    Wait {
        approval_id: String,
        #[arg(long, default_value_t = 30_000)]
        timeout_ms: u64,
    },
    /// Approve a pending request and execute the tool.
    Approve {
        approval_id: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Deny a pending request.
    Deny {
        approval_id: String,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum MemoryCommand {
    /// Search trace memory by pattern.
    Query {
        pattern: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Backup sqlite memory DB to a file.
    Backup { path: PathBuf },
    /// Restore sqlite memory DB from a backup file.
    Restore { path: PathBuf },
}

#[derive(Debug, Subcommand)]
enum DiscordCommand {
    /// Validate configured Discord token with Discord API.
    Status,
    /// Send a message to a Discord channel.
    Send { channel_id: String, message: String },
}

#[derive(Debug, Subcommand)]
enum CommCommand {
    /// List all supported channel kinds.
    List,
    /// Validate connectivity/config for a channel.
    Status { channel: String },
    /// Send a message using a channel integration.
    Send {
        channel: String,
        #[arg(long)]
        target: String,
        #[arg(long)]
        message: String,
    },
}

#[derive(Debug, Subcommand)]
enum ModelCommand {
    /// Show the currently configured model provider and id.
    Show,
    /// Configure model provider and model id.
    Set {
        provider: String,
        model: String,
        #[arg(long)]
        endpoint: Option<String>,
        #[arg(long)]
        api_key_env: Option<String>,
    },
    /// Discover Ollama models from API, CLI, and local manifests.
    ListOllama {
        #[arg(long, default_value = "http://127.0.0.1:11434")]
        endpoint: String,
    },
}

#[derive(Debug, Subcommand)]
enum SkillCommand {
    /// Validate skill manifest and wasm binary.
    Validate { skill_dir: PathBuf },
    /// Run a skill with optional args.
    Run {
        skill_dir: PathBuf,
        #[arg(long, default_value_t = 10_000)]
        timeout_ms: u64,
        #[arg(long = "arg")]
        args: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum WebCommand {
    /// Serve the local dashboard.
    Serve {
        #[arg(long, default_value = "127.0.0.1:3000")]
        bind: String,
    },
}

#[derive(Debug, Subcommand)]
enum AgentCommand {
    /// Execute delegated subtasks and aggregate outcomes for a goal.
    Delegate {
        goal_id: String,
        #[arg(long = "task")]
        tasks: Vec<String>,
        #[arg(long, default_value_t = 3)]
        max_depth: u8,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Doctor) => doctor(),
        Some(Command::Onboard) => onboard(),
        Some(Command::Goal { command }) => goal(command),
        Some(Command::Tool { command }) => tool(command),
        Some(Command::Approval { command }) => approval(command),
        Some(Command::Memory { command }) => memory(command),
        Some(Command::Discord { command }) => discord(command),
        Some(Command::Comm { command }) => comm(command),
        Some(Command::Model { command }) => model(command),
        Some(Command::Skill { command }) => skill(command),
        Some(Command::Web { command }) => web(command),
        Some(Command::Agent { command }) => agent(command),
        None => {
            println!("{APP_NAME} CLI bootstrap complete.");
            println!("Run `titan doctor` to generate and validate local config.");
            Ok(())
        }
    }
}

fn load_initialized_config() -> Result<TitanConfig> {
    let (config, _, _) = TitanConfig::load_or_create()?;
    config.validate_and_prepare()?;
    logging::init(&config.log_level);
    Ok(config)
}

fn comm(command: CommCommand) -> Result<()> {
    let _config = load_initialized_config()?;

    match command {
        CommCommand::List => {
            println!("supported_channels: {}", ChannelKind::all().len());
            for channel in ChannelKind::all() {
                println!("- {}", channel.as_str());
            }
        }
        CommCommand::Status { channel } => {
            let channel_kind = ChannelKind::parse(&channel)
                .ok_or_else(|| anyhow::anyhow!("unsupported channel: {channel}"))?;
            let status = channel_status(channel_kind)?;
            println!("channel: {}", status.channel);
            println!("configured: {}", status.configured);
            println!("status: {}", status.status);
            println!("detail: {}", status.detail);
        }
        CommCommand::Send {
            channel,
            target,
            message,
        } => {
            let channel_kind = ChannelKind::parse(&channel)
                .ok_or_else(|| anyhow::anyhow!("unsupported channel: {channel}"))?;
            let sent = channel_send(channel_kind, &target, &message)?;
            println!("channel: {}", sent.channel);
            println!("status: {}", sent.status);
            println!("detail: {}", sent.detail);
        }
    }

    Ok(())
}

fn model(command: ModelCommand) -> Result<()> {
    let (mut config, path, _) = TitanConfig::load_or_create()?;
    config.validate_and_prepare()?;
    logging::init(&config.log_level);

    match command {
        ModelCommand::Show => {
            println!("provider: {}", model_provider_name(&config.model.provider));
            println!("model: {}", config.model.model_id);
            println!(
                "endpoint: {}",
                config
                    .model
                    .endpoint
                    .clone()
                    .unwrap_or_else(|| "<none>".to_string())
            );
            println!(
                "api_key_env: {}",
                config
                    .model
                    .api_key_env
                    .clone()
                    .unwrap_or_else(|| "<none>".to_string())
            );
        }
        ModelCommand::Set {
            provider,
            model,
            endpoint,
            api_key_env,
        } => {
            let parsed = parse_model_provider(&provider)
                .ok_or_else(|| anyhow::anyhow!("unsupported model provider: {provider}"))?;
            config.model.provider = parsed.clone();
            config.model.model_id = model;
            config.model.endpoint = endpoint.or_else(|| match parsed {
                ModelProvider::Ollama => Some("http://127.0.0.1:11434".to_string()),
                _ => None,
            });
            config.model.api_key_env = api_key_env.or_else(|| default_api_key_env(&parsed));
            config.validate_and_prepare()?;
            config.save(&path)?;
            println!("model_config_saved: true");
            println!("provider: {}", model_provider_name(&config.model.provider));
            println!("model: {}", config.model.model_id);
        }
        ModelCommand::ListOllama { endpoint } => {
            let models = discover_ollama_models(&endpoint)?;
            println!("ollama_endpoint: {}", endpoint);
            println!("discovered_models: {}", models.len());
            for model in models {
                println!("- {}", model);
            }
        }
    }

    Ok(())
}

fn onboard() -> Result<()> {
    let (mut config, path, created) = TitanConfig::load_or_create()?;
    logging::init(&config.log_level);

    println!("{} onboarding wizard", APP_NAME);
    println!("config_path: {}", path.display());
    println!("created_config: {}", created);
    println!("Press Enter to accept defaults shown in brackets.");

    let workspace_input = prompt_with_default(
        "Workspace directory",
        &config.workspace_dir.display().to_string(),
    )?;
    config.workspace_dir = PathBuf::from(expand_tilde(&workspace_input));

    let mode_choice = prompt_choice(
        "Autonomy mode",
        &[
            "supervised (all actions require approval)",
            "collaborative (read auto, risky actions require approval)",
            "autonomous (no approval gates)",
        ],
        mode_index(&config.mode),
    )?;
    config.mode = match mode_choice {
        0 => AutonomyMode::Supervised,
        1 => AutonomyMode::Collaborative,
        2 => AutonomyMode::Autonomous,
        _ => unreachable!("prompt_choice enforces valid range"),
    };

    let discord_enabled = prompt_yes_no("Enable Discord integration", config.discord.enabled)?;
    config.discord.enabled = discord_enabled;
    if discord_enabled {
        let token_default = config.discord.token.clone().unwrap_or_default();
        let token = prompt_with_default("Discord bot token (DISCORD_BOT_TOKEN)", &token_default)?;
        if token.trim().is_empty() {
            config.discord.token = None;
        } else {
            config.discord.token = Some(token);
        }

        let channel_default = config
            .discord
            .default_channel_id
            .clone()
            .unwrap_or_default();
        let channel =
            prompt_with_default("Default Discord channel id (optional)", &channel_default)?;
        if channel.trim().is_empty() {
            config.discord.default_channel_id = None;
        } else {
            config.discord.default_channel_id = Some(channel);
        }
    } else {
        config.discord.token = None;
        config.discord.default_channel_id = None;
    }

    configure_model_interactive(&mut config)?;

    // Save then validate so newly chosen workspace can be created immediately.
    config.save(&path)?;
    config.validate_and_prepare()?;

    println!("onboarding_status: complete");
    println!("workspace: {}", config.workspace_dir.display());
    println!("mode: {:?}", config.mode);
    println!(
        "model_provider: {}",
        model_provider_name(&config.model.provider)
    );
    println!("model_id: {}", config.model.model_id);
    println!("discord_enabled: {}", config.discord.enabled);
    println!("next_steps:");
    println!("- Run `titan doctor`");
    println!("- Run `titan model show`");
    println!("- Run `titan comm list`");

    Ok(())
}

fn doctor() -> Result<()> {
    // Bootstraps local operator state so TITAN can run with predictable defaults.
    let (config, path, created) = TitanConfig::load_or_create()?;
    config.validate_and_prepare()?;
    logging::init(&config.log_level);

    println!("{} doctor: OK", APP_NAME);
    println!("config: {}", path.display());
    println!("workspace: {}", config.workspace_dir.display());
    println!("mode: {:?}", config.mode);
    println!("created_config: {created}");

    Ok(())
}

fn goal(command: GoalCommand) -> Result<()> {
    let config = load_initialized_config()?;

    let db_path = config.workspace_dir.join("titan.db");
    let store = MemoryStore::open(&db_path)?;

    match command {
        GoalCommand::Submit {
            description,
            dedupe_key,
            simulate,
            max_retries,
            timeout_ms,
        } => {
            if let Some(key) = &dedupe_key {
                // Persistent idempotency for external callers that may retry submissions.
                if let Some(existing) = store.find_goal_by_dedupe_key(key)? {
                    println!("dedupe_hit: true");
                    println!("goal_id: {}", existing.id);
                    println!("status: {}", existing.status);
                    println!("description: {}", existing.description);
                    return Ok(());
                }
            }

            let goal = Goal::new(description.clone()).with_dedupe_key(dedupe_key.clone());
            store.create_goal(&goal)?;
            store.add_trace_event(&TraceEvent::new(
                goal.id.clone(),
                "goal_submitted",
                description,
            ))?;

            let mut runtime = Runtime::new();
            let behavior = GoalAttemptBehavior::parse(Some(&simulate));
            let job = GoalJob {
                goal: goal.clone(),
                behavior,
            };
            if !matches!(runtime.submit(job), SubmitOutcome::Accepted) {
                println!("submit_status: duplicate");
                return Ok(());
            }

            let result = runtime
                .run_next(GoalExecutionConfig {
                    max_retries,
                    attempt_timeout_ms: timeout_ms,
                })
                .with_context(|| "submitted goal did not produce an execution result")?;

            // Persist the full runtime timeline so observers can replay what happened.
            for trace in &result.traces {
                store.add_trace_event(trace)?;
                if trace.event_type == "planning_started" {
                    store.update_goal_status(&result.goal.id, GoalStatus::Planning)?;
                }
                if trace.event_type == "execution_started" {
                    store.update_goal_status(&result.goal.id, GoalStatus::Executing)?;
                }
            }
            store.update_goal_status(&result.goal.id, result.goal.status)?;

            println!("goal_id: {}", result.goal.id);
            println!("status: {}", result.goal.status.as_str());
            println!("attempts: {}", result.attempts);
            println!("db: {}", db_path.display());
        }
        GoalCommand::Show { goal_id } => {
            if let Some(goal) = store.get_goal(&goal_id)? {
                println!("goal_id: {}", goal.id);
                println!("status: {}", goal.status);
                println!("description: {}", goal.description);
                println!(
                    "dedupe_key: {}",
                    goal.dedupe_key.unwrap_or_else(|| "<none>".to_string())
                );
                println!("traces:");
                // Ordered traces provide a minimal execution timeline for this goal.
                for event in store.get_traces(&goal_id)? {
                    println!("- {}: {}", event.event_type, event.detail);
                }
            } else {
                println!("goal not found: {goal_id}");
            }
        }
        GoalCommand::Cancel { goal_id } => {
            let Some(existing) = store.get_goal(&goal_id)? else {
                println!("goal not found: {goal_id}");
                return Ok(());
            };
            if matches!(
                existing.status.as_str(),
                "completed" | "failed" | "cancelled"
            ) {
                println!("cancel_rejected: terminal_status");
                println!("goal_id: {}", goal_id);
                println!("status: {}", existing.status);
                return Ok(());
            }
            store.update_goal_status(&goal_id, GoalStatus::Cancelled)?;
            store.add_trace_event(&TraceEvent::new(
                goal_id.clone(),
                "goal_cancelled",
                "Goal cancelled by operator command",
            ))?;
            store.add_trace_event(&TraceEvent::new(
                goal_id.clone(),
                "reflection_recorded",
                "Cancellation recorded for future planning context",
            ))?;
            println!("goal_id: {}", goal_id);
            println!("status: {}", GoalStatus::Cancelled.as_str());
        }
    }
    Ok(())
}

fn tool(command: ToolCommand) -> Result<()> {
    let config = load_initialized_config()?;

    let db_path = config.workspace_dir.join("titan.db");
    let store = MemoryStore::open(&db_path)?;
    let registry = ToolRegistry::with_defaults();

    match command {
        ToolCommand::Run {
            tool_name,
            input,
            approval_ttl_ms,
        } => {
            let Some(tool) = registry.get(&tool_name) else {
                println!("unknown_tool: {tool_name}");
                println!("available_tools:");
                for known in registry.list() {
                    println!("- {} ({})", known.name, known.class.as_str());
                }
                return Ok(());
            };

            // Apply mode-specific policy before any tool runs.
            if PolicyEngine::requires_approval(config.mode.clone(), tool.class) {
                let approval = store.create_approval_request(
                    &tool.name,
                    tool.class.as_str(),
                    input.as_deref().unwrap_or_default(),
                    Some("cli"),
                    approval_ttl_ms,
                )?;
                println!("approval_required: true");
                println!("approval_id: {}", approval.id);
                println!("nonce: {}", approval.nonce);
                println!("tool_name: {}", approval.tool_name);
                println!("capability: {}", approval.capability);
                println!("expires_at_ms: {}", approval.expires_at_ms);
                println!("status: {}", approval.status);
                return Ok(());
            }

            let exec_ctx =
                ToolExecutionContext::default_for_workspace(config.workspace_dir.clone());
            let result = ToolExecutor::execute(tool, input.as_deref(), &exec_ctx)?;
            store.record_tool_run(None, &tool.name, &result.status, &result.output)?;
            println!("approval_required: false");
            println!("tool_name: {}", tool.name);
            println!("status: {}", result.status);
            println!("output: {}", result.output);
        }
    }
    Ok(())
}

fn approval(command: ApprovalCommand) -> Result<()> {
    let config = load_initialized_config()?;

    let db_path = config.workspace_dir.join("titan.db");
    let store = MemoryStore::open(&db_path)?;
    let registry = ToolRegistry::with_defaults();

    match command {
        ApprovalCommand::List => {
            let approvals = store.list_pending_approvals()?;
            if approvals.is_empty() {
                println!("pending_approvals: 0");
                return Ok(());
            }
            println!("pending_approvals: {}", approvals.len());
            for approval in approvals {
                println!(
                    "- {} | {} | {} | {}",
                    approval.id, approval.tool_name, approval.capability, approval.status
                );
            }
        }
        ApprovalCommand::Show { approval_id } => {
            if let Some(approval) = store.get_approval_request(&approval_id)? {
                println!("approval_id: {}", approval.id);
                println!("tool_name: {}", approval.tool_name);
                println!("capability: {}", approval.capability);
                println!("status: {}", approval.status);
                println!(
                    "requested_by: {}",
                    approval
                        .requested_by
                        .unwrap_or_else(|| "<unknown>".to_string())
                );
                println!(
                    "resolved_by: {}",
                    approval.resolved_by.unwrap_or_else(|| "<none>".to_string())
                );
                println!("expires_at_ms: {}", approval.expires_at_ms);
                println!("input: {}", approval.input);
                println!(
                    "decision_reason: {}",
                    approval
                        .decision_reason
                        .unwrap_or_else(|| "<none>".to_string())
                );
            } else {
                println!("approval_not_found: {}", approval_id);
            }
        }
        ApprovalCommand::Wait {
            approval_id,
            timeout_ms,
        } => {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                if let Some(approval) = store.get_approval_request(&approval_id)? {
                    if approval.status != "pending" {
                        println!("approval_id: {}", approval.id);
                        println!("status: {}", approval.status);
                        println!(
                            "resolved_by: {}",
                            approval.resolved_by.unwrap_or_else(|| "<none>".to_string())
                        );
                        println!(
                            "decision_reason: {}",
                            approval
                                .decision_reason
                                .unwrap_or_else(|| "<none>".to_string())
                        );
                        break;
                    }
                    if Instant::now() >= deadline {
                        println!("wait_status: timeout");
                        println!("approval_id: {}", approval_id);
                        break;
                    }
                    thread::sleep(Duration::from_millis(300));
                    continue;
                }

                println!("approval_not_found: {}", approval_id);
                break;
            }
        }
        ApprovalCommand::Approve {
            approval_id,
            reason,
        } => {
            let Some(approval) = store.get_approval_request(&approval_id)? else {
                println!("approval_not_found: {}", approval_id);
                return Ok(());
            };

            if store.approval_has_tool_run(&approval_id)? {
                println!("approval_status: replay_blocked");
                println!("approval_id: {}", approval_id);
                return Ok(());
            }

            let resolved = store.resolve_approval_request(
                &approval_id,
                true,
                Some("cli"),
                reason.as_deref(),
            )?;
            if !resolved {
                println!("approval_not_pending: {}", approval_id);
                return Ok(());
            }

            // Approving triggers execution immediately to keep operator workflow single-step.
            let Some(tool) = registry.get(&approval.tool_name) else {
                println!("approval_status: approved");
                println!("execution_status: skipped_unknown_tool");
                return Ok(());
            };
            let input = if approval.input.trim().is_empty() {
                None
            } else {
                Some(approval.input.as_str())
            };
            let exec_ctx =
                ToolExecutionContext::default_for_workspace(config.workspace_dir.clone());
            let result = ToolExecutor::execute(tool, input, &exec_ctx)?;
            store.record_tool_run(
                Some(&approval_id),
                &tool.name,
                &result.status,
                &result.output,
            )?;

            println!("approval_status: approved");
            println!("tool_name: {}", tool.name);
            println!("execution_status: {}", result.status);
            println!("output: {}", result.output);
        }
        ApprovalCommand::Deny {
            approval_id,
            reason,
        } => {
            let resolved = store.resolve_approval_request(
                &approval_id,
                false,
                Some("cli"),
                reason.as_deref(),
            )?;
            if !resolved {
                println!("approval_not_pending: {}", approval_id);
                return Ok(());
            }
            println!("approval_status: denied");
            println!("approval_id: {}", approval_id);
        }
    }

    Ok(())
}

fn memory(command: MemoryCommand) -> Result<()> {
    let config = load_initialized_config()?;
    let db_path = config.workspace_dir.join("titan.db");
    let mut store = MemoryStore::open(&db_path)?;

    match command {
        MemoryCommand::Query { pattern, limit } => {
            let rows = store.search_traces(&pattern, limit)?;
            println!("matches: {}", rows.len());
            for row in rows {
                println!("- {} | {} | {}", row.goal_id, row.event_type, row.detail);
            }
        }
        MemoryCommand::Backup { path } => {
            store.backup_to(&path)?;
            println!("backup_created: {}", path.display());
        }
        MemoryCommand::Restore { path } => {
            store.restore_from(&path)?;
            println!("restore_applied: {}", path.display());
        }
    }
    Ok(())
}

fn discord(command: DiscordCommand) -> Result<()> {
    let config = load_initialized_config()?;

    let token = std::env::var("DISCORD_BOT_TOKEN")
        .ok()
        .or(config.discord.token.clone())
        .ok_or_else(|| {
            anyhow::anyhow!("discord token missing: set DISCORD_BOT_TOKEN or config.discord.token")
        })?;

    let gateway = DiscordGateway::new(&token, 10_000)?;
    match command {
        DiscordCommand::Status => {
            let me = gateway.healthcheck()?;
            println!("discord_status: ok");
            println!("bot_id: {}", me.id);
            println!("bot_username: {}", me.username);
        }
        DiscordCommand::Send {
            channel_id,
            message,
        } => {
            let sent = gateway.send_message(&channel_id, &message)?;
            println!("send_status: ok");
            println!("message_id: {}", sent.id);
            println!("channel_id: {}", sent.channel_id);
        }
    }
    Ok(())
}

fn skill(command: SkillCommand) -> Result<()> {
    let config = load_initialized_config()?;

    match command {
        SkillCommand::Validate { skill_dir } => {
            let package = SkillPackage::load(&skill_dir)?;
            println!("skill_valid: true");
            println!("name: {}", package.manifest.name);
            println!("version: {}", package.manifest.version);
            println!("entrypoint: {}", package.wasm_path.display());
        }
        SkillCommand::Run {
            skill_dir,
            timeout_ms,
            args,
        } => {
            let package = SkillPackage::load(&skill_dir)?;
            let runtime = SkillRuntime {
                workspace_root: config.workspace_dir.clone(),
                timeout_ms,
            };
            let result = runtime.run(&package, &args)?;
            println!("skill_status: {}", result.status);
            println!("output:\n{}", result.output);
        }
    }
    Ok(())
}

fn web(command: WebCommand) -> Result<()> {
    let config = load_initialized_config()?;

    match command {
        WebCommand::Serve { bind } => {
            let db_path = config.workspace_dir.join("titan.db");
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            println!("web_status: starting");
            println!("bind: {}", bind);
            println!("db: {}", db_path.display());
            runtime.block_on(web_runtime::serve(
                &bind,
                db_path,
                config.workspace_dir.clone(),
            ))?;
        }
    }
    Ok(())
}

fn agent(command: AgentCommand) -> Result<()> {
    let config = load_initialized_config()?;
    let db_path = config.workspace_dir.join("titan.db");
    let store = MemoryStore::open(&db_path)?;

    match command {
        AgentCommand::Delegate {
            goal_id,
            tasks,
            max_depth,
        } => {
            if store.get_goal(&goal_id)?.is_none() {
                println!("goal not found: {goal_id}");
                return Ok(());
            }
            if tasks.is_empty() {
                println!("no tasks provided; pass one or more --task arguments");
                return Ok(());
            }

            let mut orchestrator = SubagentOrchestrator::new(SubagentConfig {
                max_depth,
                max_parallel: 16,
            });

            for task in tasks {
                orchestrator
                    .spawn(SubagentTask::new(goal_id.clone(), task, 1))
                    .map_err(anyhow::Error::msg)?;
            }
            let result = orchestrator.run_all();

            // Persist all subagent traces under the parent goal for unified replay.
            for trace in result.traces {
                let goal_ref = if trace.goal_id == "aggregate" {
                    goal_id.clone()
                } else {
                    trace.goal_id
                };
                store.add_trace_event(&TraceEvent::new(
                    goal_ref,
                    trace.event_type,
                    trace.detail,
                ))?;
            }

            println!("delegation_status: completed");
            println!("goal_id: {}", goal_id);
            println!("subagents_completed: {}", result.completed);
            println!("subagents_failed: {}", result.failed);
        }
    }
    Ok(())
}

fn configure_model_interactive(config: &mut TitanConfig) -> Result<()> {
    let provider_choice = prompt_choice(
        "Model provider",
        &["ollama (local models)", "openai", "anthropic", "custom"],
        provider_index(&config.model.provider),
    )?;

    let provider = match provider_choice {
        0 => ModelProvider::Ollama,
        1 => ModelProvider::OpenAi,
        2 => ModelProvider::Anthropic,
        3 => ModelProvider::Custom,
        _ => unreachable!("prompt_choice enforces valid range"),
    };
    config.model.provider = provider.clone();

    match provider {
        ModelProvider::Ollama => {
            let endpoint = prompt_with_default(
                "Ollama endpoint",
                config
                    .model
                    .endpoint
                    .as_deref()
                    .unwrap_or("http://127.0.0.1:11434"),
            )?;
            let discovered = discover_ollama_models(&endpoint)?;
            if discovered.is_empty() {
                println!("No local Ollama models discovered automatically.");
                let model = prompt_with_default("Ollama model id", &config.model.model_id)?;
                config.model.model_id = model;
            } else {
                println!("Discovered Ollama models:");
                for (idx, model) in discovered.iter().enumerate() {
                    println!("{}. {}", idx + 1, model);
                }
                let selected = prompt_choice(
                    "Select Ollama model",
                    &discovered
                        .iter()
                        .map(std::string::String::as_str)
                        .collect::<Vec<_>>(),
                    discovered
                        .iter()
                        .position(|m| m == &config.model.model_id)
                        .unwrap_or(0),
                )?;
                config.model.model_id = discovered[selected].clone();
            }
            config.model.endpoint = Some(endpoint);
            config.model.api_key_env = None;
        }
        ModelProvider::OpenAi => {
            let model = prompt_with_default("OpenAI model", &config.model.model_id)?;
            config.model.model_id = model;
            config.model.endpoint = None;
            config.model.api_key_env = Some(prompt_with_default(
                "OpenAI API key env var",
                config
                    .model
                    .api_key_env
                    .as_deref()
                    .unwrap_or("OPENAI_API_KEY"),
            )?);
        }
        ModelProvider::Anthropic => {
            let model = prompt_with_default("Anthropic model", &config.model.model_id)?;
            config.model.model_id = model;
            config.model.endpoint = None;
            config.model.api_key_env = Some(prompt_with_default(
                "Anthropic API key env var",
                config
                    .model
                    .api_key_env
                    .as_deref()
                    .unwrap_or("ANTHROPIC_API_KEY"),
            )?);
        }
        ModelProvider::Custom => {
            let endpoint = prompt_with_default(
                "Custom endpoint URL",
                config.model.endpoint.as_deref().unwrap_or(""),
            )?;
            let model = prompt_with_default("Custom model id", &config.model.model_id)?;
            let api_key_env = prompt_with_default(
                "Custom API key env var (optional)",
                config.model.api_key_env.as_deref().unwrap_or(""),
            )?;
            config.model.model_id = model;
            config.model.endpoint = if endpoint.trim().is_empty() {
                None
            } else {
                Some(endpoint)
            };
            config.model.api_key_env = if api_key_env.trim().is_empty() {
                None
            } else {
                Some(api_key_env)
            };
        }
    }

    Ok(())
}

fn discover_ollama_models(endpoint: &str) -> Result<Vec<String>> {
    let mut models = BTreeSet::new();
    collect_ollama_api_models(endpoint, &mut models)?;
    collect_ollama_cli_models(&mut models);
    collect_ollama_manifest_models(&mut models)?;
    Ok(models.into_iter().collect())
}

fn collect_ollama_api_models(endpoint: &str, models: &mut BTreeSet<String>) -> Result<()> {
    let base = endpoint.trim_end_matches('/');
    if base.is_empty() {
        return Ok(());
    }
    let client = Client::new();
    let response = client.get(format!("{base}/api/tags")).send();
    let Ok(response) = response else {
        return Ok(());
    };
    if !response.status().is_success() {
        return Ok(());
    }
    let body: Value = response.json()?;
    if let Some(items) = body.get("models").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(name) = item.get("name").and_then(|v| v.as_str())
                && !name.trim().is_empty()
            {
                models.insert(name.trim().to_string());
            }
        }
    }
    Ok(())
}

fn collect_ollama_cli_models(models: &mut BTreeSet<String>) {
    let output = ProcessCommand::new("ollama").arg("list").output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines().skip(1) {
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        if !name.trim().is_empty() {
            models.insert(name.trim().to_string());
        }
    }
}

fn collect_ollama_manifest_models(models: &mut BTreeSet<String>) -> Result<()> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let root = home.join(".ollama/models/manifests");
    if !root.exists() {
        return Ok(());
    }
    collect_manifest_leaf_models(&root, &root, models)?;
    Ok(())
}

fn collect_manifest_leaf_models(
    root: &Path,
    current: &Path,
    models: &mut BTreeSet<String>,
) -> Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_manifest_leaf_models(root, &path, models)?;
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let components: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        if components.len() < 2 {
            continue;
        }
        let tag = components[components.len() - 1].clone();
        let name = components[components.len() - 2].clone();
        models.insert(format!("{name}:{tag}"));
    }
    Ok(())
}

fn prompt_with_default(label: &str, default: &str) -> Result<String> {
    print!("{label} [{default}]: ");
    io::stdout().flush()?;
    let mut input = String::new();
    let bytes = io::stdin().read_line(&mut input)?;
    if bytes == 0 {
        bail!("stdin closed while reading onboarding input");
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        Ok(default.to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

fn prompt_yes_no(label: &str, default: bool) -> Result<bool> {
    let prompt = if default { "Y/n" } else { "y/N" };
    print!("{label} [{prompt}]: ");
    io::stdout().flush()?;
    let mut input = String::new();
    let bytes = io::stdin().read_line(&mut input)?;
    if bytes == 0 {
        bail!("stdin closed while reading onboarding input");
    }
    let trimmed = input.trim().to_lowercase();
    if trimmed.is_empty() {
        return Ok(default);
    }
    match trimmed.as_str() {
        "y" | "yes" => Ok(true),
        "n" | "no" => Ok(false),
        _ => {
            println!("invalid answer, using default");
            Ok(default)
        }
    }
}

fn prompt_choice(label: &str, options: &[&str], default_idx: usize) -> Result<usize> {
    println!("{label}:");
    for (idx, option) in options.iter().enumerate() {
        println!("{}. {}", idx + 1, option);
    }
    let fallback = if default_idx < options.len() {
        default_idx
    } else {
        0
    };
    print!("Choose [default {}]: ", fallback + 1);
    io::stdout().flush()?;

    let mut input = String::new();
    let bytes = io::stdin().read_line(&mut input)?;
    if bytes == 0 {
        bail!("stdin closed while reading onboarding input");
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(fallback);
    }
    let parsed: usize = trimmed
        .parse()
        .with_context(|| format!("invalid selection: {trimmed}"))?;
    if parsed == 0 || parsed > options.len() {
        bail!("selection out of range");
    }
    Ok(parsed - 1)
}

fn parse_model_provider(input: &str) -> Option<ModelProvider> {
    match input.trim().to_lowercase().as_str() {
        "openai" | "open_ai" => Some(ModelProvider::OpenAi),
        "anthropic" => Some(ModelProvider::Anthropic),
        "ollama" => Some(ModelProvider::Ollama),
        "custom" => Some(ModelProvider::Custom),
        _ => None,
    }
}

fn default_api_key_env(provider: &ModelProvider) -> Option<String> {
    match provider {
        ModelProvider::OpenAi => Some("OPENAI_API_KEY".to_string()),
        ModelProvider::Anthropic => Some("ANTHROPIC_API_KEY".to_string()),
        _ => None,
    }
}

fn model_provider_name(provider: &ModelProvider) -> &'static str {
    match provider {
        ModelProvider::OpenAi => "openai",
        ModelProvider::Anthropic => "anthropic",
        ModelProvider::Ollama => "ollama",
        ModelProvider::Custom => "custom",
    }
}

fn mode_index(mode: &AutonomyMode) -> usize {
    match mode {
        AutonomyMode::Supervised => 0,
        AutonomyMode::Collaborative => 1,
        AutonomyMode::Autonomous => 2,
    }
}

fn provider_index(provider: &ModelProvider) -> usize {
    match provider {
        ModelProvider::Ollama => 0,
        ModelProvider::OpenAi => 1,
        ModelProvider::Anthropic => 2,
        ModelProvider::Custom => 3,
    }
}

fn expand_tilde(path: &str) -> String {
    if !path.starts_with('~') {
        return path.to_string();
    }
    let Some(home) = dirs::home_dir() else {
        return path.to_string();
    };
    if path == "~" {
        return home.display().to_string();
    }
    path.replacen('~', &home.display().to_string(), 1)
}
