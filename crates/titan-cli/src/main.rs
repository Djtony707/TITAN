use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use reqwest::blocking::Client;
use serde_json::Value;
use serenity::all::{GatewayIntents, Message, Ready};
use serenity::async_trait;
use serenity::prelude::{Context as SerenityContext, EventHandler};
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use titan_common::config::{AutonomyMode, ModelProvider, TitanConfig};
use titan_common::{APP_NAME, logging};
use titan_comms::{ChannelKind, channel_send, channel_status};
use titan_connectors::{
    CompositeSecretResolver, ConnectorType, execute_connector_tool_after_approval, test_connector,
};
use titan_core::{
    Goal, GoalAttemptBehavior, GoalExecutionConfig, GoalJob, GoalStatus, Runtime, SubagentConfig,
    SubagentOrchestrator, SubagentTask, SubmitOutcome, TraceEvent,
};
use titan_discord::DiscordGateway;
use titan_gateway::{Channel as GatewayChannel, InboundEvent, TitanGatewayRuntime};
use titan_memory::{MemoryStore, RiskMode};
use titan_secrets::{SecretsStatus, SecretsStore};
use titan_skills::{
    LocalRegistryAdapter, SkillPackage, SkillRegistryAdapter, SkillRunState,
    approval_payload_for_stage, deny_unsigned_risky_install, deserialize_approval_payload,
    finalize_install_from_payload, inspect_registry_v1, list_installed_skills_v1,
    remove_installed_skill_v1, run_skill_v1, search_registry_v1, serialize_approval_payload,
    stage_install_v1,
};
use titan_tools::{PolicyEngine, ToolExecutionContext, ToolExecutor, ToolRegistry, ToolRiskMode};
use titan_web as web_runtime;
use uuid::Uuid;

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
    /// Run core runtime services (Discord loop + web UI).
    Run {
        #[arg(long, default_value = "127.0.0.1:3000")]
        bind: String,
        #[arg(long, default_value_t = 2_000)]
        poll_interval_ms: u64,
    },
    /// Alias for `run`.
    Start {
        #[arg(long, default_value = "127.0.0.1:3000")]
        bind: String,
        #[arg(long, default_value_t = 2_000)]
        poll_interval_ms: u64,
    },
    /// Guided first-run setup (workspace, mode, channels, model selection).
    Onboard {
        /// Install a startup daemon after setup completes.
        #[arg(long, default_value_t = false)]
        install_daemon: bool,
        /// Apply defaults/non-interactive values and skip prompts.
        #[arg(long, default_value_t = false)]
        yes: bool,
    },
    /// Alias for `onboard` for first-time setup.
    Setup {
        /// Install a startup daemon after setup completes.
        #[arg(long, default_value_t = false)]
        install_daemon: bool,
        /// Apply defaults/non-interactive values and skip prompts.
        #[arg(long, default_value_t = false)]
        yes: bool,
    },
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
    /// Session operations.
    Session {
        #[command(subcommand)]
        command: SessionCommand,
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
    /// Risk mode controls (SECURE/YOLO).
    Yolo {
        #[command(subcommand)]
        command: YoloCommand,
    },
    /// Set risk mode quickly.
    Mode { risk_mode: String },
    /// Encrypted local secrets store operations.
    Secrets {
        #[command(subcommand)]
        command: SecretsCommand,
    },
    /// Connector lifecycle and health commands.
    Connector {
        #[command(subcommand)]
        command: ConnectorCommand,
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
enum SessionCommand {
    /// List recent sessions.
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Show one session details.
    Show { session_id: String },
    /// Reset session history.
    Reset { session_id: String },
    /// Compact session history.
    Compact {
        session_id: String,
        #[arg(long)]
        instructions: Option<String>,
    },
    /// Stop a session run queue.
    Stop { session_id: String },
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
enum YoloCommand {
    Status,
    Arm,
    Enable {
        code: String,
        phrase: String,
        #[arg(long, default_value_t = 15)]
        ttl: i64,
    },
    Disable,
}

#[derive(Debug, Subcommand)]
enum SecretsCommand {
    /// Show whether encrypted secrets store is currently locked.
    Status,
    /// Unlock encrypted secrets store for this process.
    Unlock,
    /// Lock encrypted secrets store for this process.
    Lock,
}

#[derive(Debug, Subcommand)]
enum ConnectorCommand {
    /// List configured connectors.
    List,
    /// Add a connector row.
    Add {
        connector_type: String,
        #[arg(long)]
        name: Option<String>,
    },
    /// Configure connector fields and secret material.
    Configure { id: String },
    /// Run connector health check and persist last test status.
    Test { id: String },
    /// Remove connector by id.
    Remove { id: String },
}

#[derive(Debug, Subcommand)]
enum SkillCommand {
    /// Search registry entries by slug/name.
    Search {
        query: String,
        #[arg(long, default_value = "local")]
        source: String,
    },
    /// Install a skill from a registry.
    Install {
        skill: String,
        #[arg(long, default_value = "local")]
        source: String,
        #[arg(long, default_value_t = false)]
        force: bool,
    },
    /// List installed skills.
    List,
    /// Inspect one skill (installed preferred; falls back to registry).
    Inspect {
        slug: String,
        #[arg(long, default_value = "local")]
        source: String,
    },
    /// Update one or all skills.
    Update {
        #[arg(long, default_value_t = false)]
        all: bool,
        slug: Option<String>,
        #[arg(long, default_value = "local")]
        source: String,
        #[arg(long, default_value_t = false)]
        force: bool,
    },
    /// Remove installed skill by slug.
    Remove { slug: String },
    /// Validate installed skill against lock/hash/signature policy.
    Doctor { slug: String },
    /// Run an installed skill through broker + policy.
    Run {
        slug: String,
        #[arg(long)]
        input: Option<String>,
    },
    /// Validate skill manifest and wasm binary.
    Validate { skill_dir: PathBuf },
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
        Some(Command::Run {
            bind,
            poll_interval_ms,
        }) => run_services(bind, poll_interval_ms),
        Some(Command::Start {
            bind,
            poll_interval_ms,
        }) => run_services(bind, poll_interval_ms),
        Some(Command::Onboard {
            install_daemon,
            yes,
        }) => onboard(install_daemon, yes),
        Some(Command::Setup {
            install_daemon,
            yes,
        }) => onboard(install_daemon, yes),
        Some(Command::Goal { command }) => goal(command),
        Some(Command::Tool { command }) => tool(command),
        Some(Command::Approval { command }) => approval(command),
        Some(Command::Memory { command }) => memory(command),
        Some(Command::Session { command }) => session(command),
        Some(Command::Discord { command }) => discord(command),
        Some(Command::Comm { command }) => comm(command),
        Some(Command::Model { command }) => model(command),
        Some(Command::Yolo { command }) => yolo(command),
        Some(Command::Mode { risk_mode }) => mode_risk(&risk_mode),
        Some(Command::Secrets { command }) => secrets(command),
        Some(Command::Connector { command }) => connector(command),
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

const YOLO_ENABLE_PHRASE: &str = "I_ACCEPT_UNBOUNDED_AUTONOMY";

fn yolo(command: YoloCommand) -> Result<()> {
    let config = load_initialized_config()?;
    let store = MemoryStore::open(&config.workspace_dir.join("titan.db"))?;
    match command {
        YoloCommand::Status => {
            let state = store.get_runtime_risk_state()?;
            println!("risk_mode: {}", state.risk_mode.as_str());
            println!(
                "yolo_expires_at_ms: {}",
                state
                    .yolo_expires_at_ms
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "<none>".to_string())
            );
            println!(
                "yolo_armed: {}",
                state.yolo_armed_token.is_some() && matches!(state.risk_mode, RiskMode::Secure)
            );
            println!(
                "last_changed: {} by={}",
                state.last_changed_at_ms, state.last_changed_by
            );
        }
        YoloCommand::Arm => {
            let code = store.arm_yolo("cli")?;
            println!("yolo_armed_code: {}", code);
            println!("required_phrase: {}", YOLO_ENABLE_PHRASE);
            println!("default_ttl_minutes: 15");
        }
        YoloCommand::Enable { code, phrase, ttl } => {
            let state = store.get_runtime_risk_state()?;
            let armed = state
                .yolo_armed_token
                .ok_or_else(|| anyhow::anyhow!("yolo not armed; run `titan yolo arm` first"))?;
            if armed != code {
                bail!("invalid yolo arm code");
            }
            if phrase != YOLO_ENABLE_PHRASE {
                bail!("invalid yolo enable phrase");
            }
            store.enable_yolo("cli", ttl)?;
            let new_state = store.get_runtime_risk_state()?;
            println!("risk_mode: {}", new_state.risk_mode.as_str());
            println!(
                "yolo_expires_at_ms: {}",
                new_state
                    .yolo_expires_at_ms
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "<none>".to_string())
            );
        }
        YoloCommand::Disable => {
            store.set_risk_mode_secure("cli")?;
            println!("risk_mode: secure");
        }
    }
    Ok(())
}

fn mode_risk(risk_mode: &str) -> Result<()> {
    let requested = RiskMode::parse(risk_mode);
    let config = load_initialized_config()?;
    let store = MemoryStore::open(&config.workspace_dir.join("titan.db"))?;
    if matches!(requested, RiskMode::Secure) {
        store.set_risk_mode_secure("cli")?;
        println!("risk_mode: secure");
        return Ok(());
    }
    bail!("yolo cannot be enabled via `titan mode`; use `titan yolo arm` then `titan yolo enable`");
}

fn secrets(command: SecretsCommand) -> Result<()> {
    match command {
        SecretsCommand::Status => {
            let store = SecretsStore::open_default();
            println!(
                "status: {}",
                match store.status() {
                    SecretsStatus::Locked => "locked",
                    SecretsStatus::Unlocked => "unlocked",
                }
            );
            println!("path: {}", SecretsStore::default_path().display());
        }
        SecretsCommand::Unlock => {
            let passphrase = prompt_with_default("Secrets passphrase", "")?;
            if passphrase.trim().is_empty() {
                bail!("passphrase cannot be empty");
            }
            let mut store = SecretsStore::open_default();
            store.unlock(&passphrase)?;
            let key_count = store.list_keys()?.len();
            println!("status: unlocked");
            println!("keys: {key_count}");
        }
        SecretsCommand::Lock => {
            let mut store = SecretsStore::open_default();
            store.lock();
            println!("status: locked");
        }
    }
    Ok(())
}

fn connector(command: ConnectorCommand) -> Result<()> {
    let config = load_initialized_config()?;
    let store = MemoryStore::open(&config.workspace_dir.join("titan.db"))?;
    match command {
        ConnectorCommand::List => {
            let rows = store.list_connectors()?;
            println!("connectors: {}", rows.len());
            for row in rows {
                println!(
                    "- {} | {} | {} | last_test={}",
                    row.id,
                    row.connector_type,
                    row.display_name,
                    row.last_test_status
                        .unwrap_or_else(|| "<never>".to_string())
                );
            }
        }
        ConnectorCommand::Add {
            connector_type,
            name,
        } => {
            let parsed = ConnectorType::parse(&connector_type)
                .ok_or_else(|| anyhow::anyhow!("unsupported connector type: {connector_type}"))?;
            let id = Uuid::new_v4().to_string();
            let display_name = name.unwrap_or_else(|| parsed.as_str().to_string());
            let config_json = default_connector_config(parsed)?.to_string();
            store.add_connector(&id, parsed.as_str(), &display_name, &config_json)?;
            println!("connector_added: {id}");
            println!("type: {}", parsed.as_str());
            println!("display_name: {display_name}");
        }
        ConnectorCommand::Configure { id } => {
            let row = store
                .get_connector(&id)?
                .ok_or_else(|| anyhow::anyhow!("connector not found: {id}"))?;
            let parsed = ConnectorType::parse(&row.connector_type).ok_or_else(|| {
                anyhow::anyhow!("unsupported connector type: {}", row.connector_type)
            })?;
            let existing_cfg: Value = serde_json::from_str(&row.config_json)
                .with_context(|| "invalid connector config json")?;
            let mut store_secrets = maybe_unlock_secrets_store_interactive()?;

            let (display_name, config_json) = match parsed {
                ConnectorType::Github => {
                    let display_name = prompt_with_default("Display name", &row.display_name)?;
                    let owner_default = existing_cfg
                        .get("owner")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let repo_default = existing_cfg
                        .get("repo")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let base_default = existing_cfg
                        .get("base_url")
                        .and_then(Value::as_str)
                        .unwrap_or("https://api.github.com");
                    let owner = prompt_with_default("GitHub owner", owner_default)?;
                    let repo = prompt_with_default("GitHub repo", repo_default)?;
                    let base_url = prompt_with_default("GitHub API base URL", base_default)?;
                    let token = prompt_with_default("GitHub token (blank to keep env-only)", "")?;
                    if !token.trim().is_empty() {
                        if let Some(secrets) = &mut store_secrets {
                            secrets.set_secret(
                                &format!("connector:{id}:github_token"),
                                token.trim(),
                            )?;
                        } else {
                            bail!("secrets store is locked; unlock to persist connector token");
                        }
                    }
                    (
                        display_name,
                        serde_json::json!({
                            "owner": owner,
                            "repo": repo,
                            "base_url": base_url,
                        }),
                    )
                }
                ConnectorType::GoogleCalendar => {
                    let display_name = prompt_with_default("Display name", &row.display_name)?;
                    let calendar_id_default = existing_cfg
                        .get("calendar_id")
                        .and_then(Value::as_str)
                        .unwrap_or("primary");
                    let base_default = existing_cfg
                        .get("base_url")
                        .and_then(Value::as_str)
                        .unwrap_or("https://www.googleapis.com/calendar/v3");
                    let env_default = existing_cfg
                        .get("access_token_env")
                        .and_then(Value::as_str)
                        .unwrap_or("GOOGLE_CALENDAR_TOKEN");
                    let calendar_id = prompt_with_default("Calendar ID", calendar_id_default)?;
                    let base_url =
                        prompt_with_default("Google Calendar API base URL", base_default)?;
                    let access_token_env =
                        prompt_with_default("Access token env var name", env_default)?;
                    let token = prompt_with_default("Calendar token (blank to keep env-only)", "")?;
                    if !token.trim().is_empty() {
                        if let Some(secrets) = &mut store_secrets {
                            secrets
                                .set_secret(&format!("connector:{id}:gcal_token"), token.trim())?;
                        } else {
                            bail!("secrets store is locked; unlock to persist connector token");
                        }
                    }
                    (
                        display_name,
                        serde_json::json!({
                            "calendar_id": calendar_id,
                            "base_url": base_url,
                            "access_token_env": access_token_env,
                        }),
                    )
                }
            };

            let updated = store.update_connector(&id, &display_name, &config_json.to_string())?;
            println!("connector_config_updated: {updated}");
            println!("connector_id: {id}");
        }
        ConnectorCommand::Test { id } => {
            let resolver = CompositeSecretResolver::from_env()?;
            let health = test_connector(&store, &id, &resolver)?;
            println!("connector_id: {id}");
            println!("health_ok: {}", health.ok);
            println!("detail: {}", health.detail);
        }
        ConnectorCommand::Remove { id } => {
            let removed = store.remove_connector(&id)?;
            println!("connector_removed: {removed}");
            println!("connector_id: {id}");
        }
    }
    Ok(())
}

fn onboard(install_daemon: bool, accept_defaults: bool) -> Result<()> {
    let (mut config, path, created) = TitanConfig::load_or_create()?;
    logging::init(&config.log_level);

    println!("{} onboarding wizard", APP_NAME);
    println!("config_path: {}", path.display());
    println!("created_config: {}", created);
    if accept_defaults {
        println!("mode: non-interactive (--yes)");
        // Minimal-friction defaults for first-time setup.
        config.mode = AutonomyMode::Collaborative;
        if let Some(token) = resolve_discord_token(&config) {
            config.discord.enabled = true;
            config.discord.token = Some(token);
            config.discord.default_channel_id = config
                .discord
                .default_channel_id
                .clone()
                .or_else(resolve_discord_channel_from_env);
        } else {
            config.discord.enabled = false;
            config.discord.token = None;
            config.discord.default_channel_id = None;
        }
        auto_configure_model_defaults(&mut config)?;
        if let Ok(passphrase) = std::env::var("TITAN_SECRETS_PASSPHRASE")
            && !passphrase.trim().is_empty()
        {
            let mut secrets = SecretsStore::open_default();
            secrets.unlock(passphrase.trim())?;
        }
    } else {
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
            let token_default = resolve_discord_token(&config).unwrap_or_default();
            let token =
                prompt_with_default("Discord bot token (DISCORD_BOT_TOKEN)", &token_default)?;
            if token.trim().is_empty() {
                config.discord.token = None;
            } else {
                config.discord.token = Some(token);
            }

            let channel_default = config
                .discord
                .default_channel_id
                .clone()
                .or_else(resolve_discord_channel_from_env)
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

        let passphrase = prompt_with_default(
            "Set a TITAN secrets passphrase (blank to use env-vars only)",
            "",
        )?;
        if passphrase.trim().is_empty() {
            println!("secrets_store: locked (env vars only)");
        } else {
            let mut secrets = SecretsStore::open_default();
            secrets.unlock(passphrase.trim())?;
            println!("secrets_store: initialized");
        }
    }

    // Save then validate so newly chosen workspace can be created immediately.
    config.save(&path)?;
    config.validate_and_prepare()?;
    let doctor_status = doctor();
    if let Err(err) = doctor_status {
        println!("post_onboard_doctor: failed ({err})");
    } else {
        println!("post_onboard_doctor: ok");
    }

    println!("onboarding_status: complete");
    println!("workspace: {}", config.workspace_dir.display());
    println!("mode: {:?}", config.mode);
    println!(
        "model_provider: {}",
        model_provider_name(&config.model.provider)
    );
    println!("model_id: {}", config.model.model_id);
    println!("discord_enabled: {}", config.discord.enabled);
    if config.discord.enabled {
        report_discord_onboarding_status(&config)?;
    }
    if install_daemon {
        let daemon = install_startup_daemon()?;
        println!("daemon_installed: true");
        println!("daemon_kind: {}", daemon.kind);
        println!("daemon_detail: {}", daemon.detail);
    } else {
        println!("daemon_installed: false");
    }
    println!("next_steps:");
    println!("- Run `titan doctor`");
    println!("- Run `titan model show`");
    println!("- Run `titan comm list`");
    if !install_daemon {
        println!("- Optional: run `titan setup --install-daemon`");
    }

    Ok(())
}

#[derive(Debug)]
struct DaemonInstallResult {
    kind: &'static str,
    detail: String,
}

fn install_startup_daemon() -> Result<DaemonInstallResult> {
    let exe = std::env::current_exe().with_context(|| "failed to resolve titan executable path")?;
    let exe_str = exe
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("executable path contains invalid UTF-8"))?;

    if cfg!(target_os = "linux") {
        return install_linux_user_daemon(exe_str);
    }
    if cfg!(target_os = "macos") {
        return install_macos_launch_agent(exe_str);
    }
    if cfg!(target_os = "windows") {
        return install_windows_task(exe_str);
    }

    bail!("daemon install not supported on this platform")
}

fn install_linux_user_daemon(exe: &str) -> Result<DaemonInstallResult> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("home directory not found"))?;
    let service_dir = home.join(".config/systemd/user");
    fs::create_dir_all(&service_dir)?;
    let service_path = service_dir.join("titan.service");
    let service = format!(
        "[Unit]\nDescription=TITAN User Service\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={} web serve --bind 127.0.0.1:3000\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n",
        shell_escape_arg(exe)
    );
    fs::write(&service_path, service)?;

    let _ = ProcessCommand::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    let _ = ProcessCommand::new("systemctl")
        .args(["--user", "enable", "--now", "titan.service"])
        .status();

    Ok(DaemonInstallResult {
        kind: "systemd-user",
        detail: format!(
            "service file at {} (enabled if systemctl --user is available)",
            service_path.display()
        ),
    })
}

fn install_macos_launch_agent(exe: &str) -> Result<DaemonInstallResult> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("home directory not found"))?;
    let launch_dir = home.join("Library/LaunchAgents");
    fs::create_dir_all(&launch_dir)?;
    let plist_path = launch_dir.join("dev.titan.agent.plist");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.titan.agent</string>
    <key>ProgramArguments</key>
    <array>
      <string>{}</string>
      <string>web</string>
      <string>serve</string>
      <string>--bind</string>
      <string>127.0.0.1:3000</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
"#,
        xml_escape(exe)
    );
    fs::write(&plist_path, plist)?;
    let _ = ProcessCommand::new("launchctl")
        .args(["load", "-w", plist_path.to_string_lossy().as_ref()])
        .status();

    Ok(DaemonInstallResult {
        kind: "launchd",
        detail: format!("launch agent at {}", plist_path.display()),
    })
}

fn install_windows_task(exe: &str) -> Result<DaemonInstallResult> {
    let task_name = "TITAN";
    let tr = format!("\"{exe}\" web serve --bind 127.0.0.1:3000");
    let status = ProcessCommand::new("schtasks")
        .args([
            "/Create", "/F", "/TN", task_name, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", &tr,
        ])
        .status()
        .with_context(|| "failed to invoke schtasks for daemon install")?;
    if !status.success() {
        bail!("schtasks failed with status {}", status);
    }
    let _ = ProcessCommand::new("schtasks")
        .args(["/Run", "/TN", task_name])
        .status();

    Ok(DaemonInstallResult {
        kind: "windows-task",
        detail: format!("scheduled task '{}' installed", task_name),
    })
}

fn shell_escape_arg(arg: &str) -> String {
    if arg
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}

fn doctor() -> Result<()> {
    // Bootstraps local operator state so TITAN can run with predictable defaults.
    let (config, path, created) = TitanConfig::load_or_create()?;
    config.validate_and_prepare()?;
    logging::init(&config.log_level);
    let db_path = config.workspace_dir.join("titan.db");
    let _store = MemoryStore::open(&db_path)?;

    let bind_addr = web_runtime::default_bind_addr();
    let parsed_bind = bind_addr
        .parse::<std::net::SocketAddr>()
        .with_context(|| format!("invalid default web bind address: {bind_addr}"))?;
    let listener = std::net::TcpListener::bind(parsed_bind)
        .with_context(|| format!("web bind check failed for {bind_addr}"))?;
    drop(listener);

    let discord_token = resolve_discord_token(&config);
    let discord_config_ok = if config.discord.enabled {
        discord_token.is_some()
    } else {
        true
    };
    if config.discord.enabled && !discord_config_ok {
        bail!("discord is enabled but no token found in config or DISCORD_BOT_TOKEN/DISCORD_TOKEN");
    }
    let default_channel_id = resolve_discord_channel_id(&config);
    if config.discord.enabled && default_channel_id.is_none() {
        bail!("discord.default_channel_id must be a numeric id when discord is enabled");
    }

    println!("{} doctor: OK", APP_NAME);
    println!("config: {}", path.display());
    println!("workspace: {}", config.workspace_dir.display());
    println!("db: {}", db_path.display());
    println!("mode: {:?}", config.mode);
    println!("discord_enabled: {}", config.discord.enabled);
    println!("discord_token_present: {}", discord_token.is_some());
    println!("discord_config_ok: {}", discord_config_ok);
    println!("web_bind_default: {}", bind_addr);
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
    store.apply_yolo_expiry("cli")?;
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
            let risk_state = store.get_runtime_risk_state()?;
            let risk = if matches!(risk_state.risk_mode, RiskMode::Yolo) {
                ToolRiskMode::Yolo
            } else {
                ToolRiskMode::Secure
            };
            if PolicyEngine::requires_approval_with_risk(config.mode.clone(), risk, tool.class) {
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

            let mut exec_ctx =
                ToolExecutionContext::default_for_workspace(config.workspace_dir.clone());
            exec_ctx.bypass_path_guard = matches!(risk_state.risk_mode, RiskMode::Yolo)
                && risk_state.yolo_bypass_path_guard
                && config.security.yolo_bypass_path_guard;
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
    store.apply_yolo_expiry("cli")?;
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

            if approval.tool_name == "skill_install" {
                let payload = deserialize_approval_payload(&approval.input)?;
                let installed = finalize_install_from_payload(&payload)?;
                persist_installed_skill(&store, &installed)?;
                println!("approval_status: approved");
                println!("install_status: finalized");
                println!("slug: {}", installed.manifest.slug);
                println!("version: {}", installed.manifest.version);
                return Ok(());
            }

            if approval.tool_name == "skill_exec_grant" {
                println!("approval_status: approved");
                println!("grant: skill_exec");
                println!("slug: {}", approval.input);
                return Ok(());
            }

            if approval.tool_name == "connector_tool" {
                let resolver = CompositeSecretResolver::from_env()?;
                let outcome = execute_connector_tool_after_approval(
                    &store,
                    "cli",
                    &approval.input,
                    &resolver,
                )?;
                println!("approval_status: approved");
                println!("execution_status: {}", outcome.result_status);
                println!("goal_id: {}", outcome.goal_id);
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
            let mut exec_ctx =
                ToolExecutionContext::default_for_workspace(config.workspace_dir.clone());
            let risk_state = store.get_runtime_risk_state()?;
            exec_ctx.bypass_path_guard = matches!(risk_state.risk_mode, RiskMode::Yolo)
                && risk_state.yolo_bypass_path_guard
                && config.security.yolo_bypass_path_guard;
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

fn session(command: SessionCommand) -> Result<()> {
    let config = load_initialized_config()?;
    let db_path = config.workspace_dir.join("titan.db");
    let store = MemoryStore::open(&db_path)?;

    match command {
        SessionCommand::List { limit } => {
            let rows = store.list_sessions(limit.min(200))?;
            println!("sessions: {}", rows.len());
            for row in rows {
                println!(
                    "- {} | {}:{} | queue={} | compactions={} | activation={} | usage={}",
                    row.id,
                    row.channel,
                    row.peer_id,
                    row.queue_depth,
                    row.compactions_count,
                    row.activation_mode,
                    row.usage_mode
                );
            }
        }
        SessionCommand::Show { session_id } => {
            let Some(row) = store.get_session(&session_id)? else {
                println!("session_not_found: {session_id}");
                return Ok(());
            };
            println!("session_id: {}", row.id);
            println!("channel: {}", row.channel);
            println!("peer_id: {}", row.peer_id);
            println!(
                "model_override: {}",
                row.model_override
                    .unwrap_or_else(|| "<default>".to_string())
            );
            println!("usage_mode: {}", row.usage_mode);
            println!("activation_mode: {}", row.activation_mode);
            println!("compactions_count: {}", row.compactions_count);
            println!("queue_depth: {}", row.queue_depth);
            println!("stop_requested: {}", row.stop_requested);
            let messages = store.list_session_messages(&session_id, 20)?;
            println!("recent_messages: {}", messages.len());
        }
        SessionCommand::Reset { session_id } => {
            let deleted = store.reset_session(&session_id)?;
            println!("session_reset: {}", session_id);
            println!("messages_deleted: {}", deleted);
        }
        SessionCommand::Compact {
            session_id,
            instructions,
        } => {
            let compacted = store.compact_session(&session_id, instructions.as_deref())?;
            println!("session_compact: {}", session_id);
            println!("messages_compacted: {}", compacted);
        }
        SessionCommand::Stop { session_id } => {
            store.mark_session_stop(&session_id)?;
            println!("session_stop_requested: {}", session_id);
        }
    }
    Ok(())
}

fn discord(command: DiscordCommand) -> Result<()> {
    let config = load_initialized_config()?;

    let token = resolve_discord_token(&config).ok_or_else(|| {
        anyhow::anyhow!(
            "discord token missing: set DISCORD_BOT_TOKEN or DISCORD_TOKEN or config.discord.token"
        )
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
    let workspace_root = config.workspace_dir.clone();
    let store = MemoryStore::open(&workspace_root.join("titan.db"))?;

    match command {
        SkillCommand::Search { query, source } => {
            let adapter = registry_adapter_from_source(&source)?;
            let hits = search_registry_v1(adapter.as_ref(), &query)?;
            println!("results: {}", hits.len());
            for item in hits {
                println!("{} {} latest={}", item.slug, item.name, item.latest);
            }
        }
        SkillCommand::Install {
            skill,
            source,
            force,
        } => {
            let (slug, version) = parse_slug_and_version(&skill);
            let adapter = registry_adapter_from_source(&source)?;
            let staged = stage_install_v1(
                adapter.as_ref(),
                &workspace_root,
                &slug,
                version.as_deref(),
                force,
            )?;
            deny_unsigned_risky_install(&staged)?;
            let payload = approval_payload_for_stage(&staged);
            let payload_json = serialize_approval_payload(&payload)?;
            let approval = store.create_approval_request(
                "skill_install",
                "write",
                &payload_json,
                Some("cli"),
                300_000,
            )?;

            let read_only = staged
                .manifest
                .permissions
                .scopes
                .iter()
                .all(|scope| matches!(scope, titan_skills::SkillScope::Read));
            let auto_finalize = matches!(config.mode, AutonomyMode::Autonomous)
                || (matches!(config.mode, AutonomyMode::Supervised) && read_only);

            if auto_finalize {
                store.resolve_approval_request(
                    &approval.id,
                    true,
                    Some("cli-auto"),
                    Some("auto-approved by mode policy"),
                )?;
                let installed = finalize_install_from_payload(&payload)?;
                persist_installed_skill(&store, &installed)?;
                println!(
                    "installed: {}@{}",
                    installed.manifest.slug, installed.manifest.version
                );
                println!("approval_id: {}", approval.id);
                println!("signature_status: {}", installed.signature_status);
                println!(
                    "scopes: {}",
                    format_skill_scopes(&installed.manifest.permissions.scopes)
                );
            } else {
                println!("approval_required: true");
                println!("approval_id: {}", approval.id);
                println!("slug: {}", payload.slug);
                println!("version: {}", payload.version);
                println!("signature_status: {}", payload.signature_status);
                println!("scopes: {}", payload.scopes.join(","));
            }
        }
        SkillCommand::List => {
            let items = list_installed_skills_v1(&workspace_root)?;
            println!("installed_skills: {}", items.len());
            for skill in items {
                println!(
                    "{} {} signed={} scopes={}",
                    skill.manifest.slug,
                    skill.manifest.version,
                    skill.signature_status,
                    format_skill_scopes(&skill.manifest.permissions.scopes)
                );
            }
        }
        SkillCommand::Inspect { slug, source } => {
            if let Some(local) = list_installed_skills_v1(&workspace_root)?
                .into_iter()
                .find(|s| s.manifest.slug == slug)
            {
                println!("slug: {}", local.manifest.slug);
                println!("name: {}", local.manifest.name);
                println!("version: {}", local.manifest.version);
                println!("entrypoint_type: {:?}", local.manifest.entrypoint_type);
                println!("entrypoint: {}", local.manifest.entrypoint);
                println!("signature_status: {}", local.signature_status);
                println!(
                    "scopes: {}",
                    format_skill_scopes(&local.manifest.permissions.scopes)
                );
                return Ok(());
            }
            let adapter = registry_adapter_from_source(&source)?;
            let resolved = inspect_registry_v1(adapter.as_ref(), &slug, None)?;
            println!("slug: {}", resolved.slug);
            println!("name: {}", resolved.name);
            println!("version: {}", resolved.version);
            println!("sha256: {}", resolved.sha256);
            println!("download_url: {}", resolved.download_url);
        }
        SkillCommand::Update {
            all,
            slug,
            source,
            force,
        } => {
            let targets = if all {
                list_installed_skills_v1(&workspace_root)?
                    .into_iter()
                    .map(|skill| skill.manifest.slug)
                    .collect::<Vec<_>>()
            } else {
                vec![slug.ok_or_else(|| anyhow::anyhow!("provide <slug> or --all"))?]
            };
            for item in targets {
                skill(SkillCommand::Install {
                    skill: item,
                    source: source.clone(),
                    force,
                })?;
            }
        }
        SkillCommand::Remove { slug } => {
            let removed = remove_installed_skill_v1(&workspace_root, &slug)?;
            let _ = store.remove_installed_skill(&slug)?;
            println!("removed: {}", removed);
            println!("slug: {}", slug);
        }
        SkillCommand::Doctor { slug } => {
            let Some(skill) = list_installed_skills_v1(&workspace_root)?
                .into_iter()
                .find(|s| s.manifest.slug == slug)
            else {
                bail!("skill not installed: {slug}");
            };
            let lock = titan_skills::load_skills_lock_v1(&workspace_root.join("skills.lock"))?;
            let lock_entry = lock
                .entries
                .iter()
                .find(|entry| entry.slug == skill.manifest.slug);
            println!("slug: {}", skill.manifest.slug);
            println!("version: {}", skill.manifest.version);
            println!("signature_status: {}", skill.signature_status);
            println!(
                "scopes: {}",
                format_skill_scopes(&skill.manifest.permissions.scopes)
            );
            println!(
                "lock_aligned: {}",
                lock_entry
                    .map(|entry| entry.hash == skill.hash && entry.version == skill.manifest.version)
                    .unwrap_or(false)
            );
        }
        SkillCommand::Run { slug, input } => {
            let outcome = run_skill_v1(
                &store,
                &workspace_root,
                config.mode.clone(),
                "cli",
                &slug,
                input.as_deref(),
            )?;
            match outcome.state {
                SkillRunState::Completed => {
                    println!("state: completed");
                    println!("goal_id: {}", outcome.goal_id);
                    println!("output:\n{}", outcome.output);
                }
                SkillRunState::PendingApproval(approval_id) => {
                    println!("state: pending_approval");
                    println!("goal_id: {}", outcome.goal_id);
                    println!("approval_id: {}", approval_id);
                    println!("detail: {}", outcome.output);
                }
            }
        }
        SkillCommand::Validate { skill_dir } => {
            let package = SkillPackage::load(&skill_dir)?;
            println!("skill_valid: true");
            println!("name: {}", package.manifest.name);
            println!("version: {}", package.manifest.version);
            println!("entrypoint: {}", package.wasm_path.display());
        }
    }
    Ok(())
}

fn registry_adapter_from_source(source: &str) -> Result<Box<dyn SkillRegistryAdapter>> {
    let trimmed = source.trim();
    if trimmed.eq_ignore_ascii_case("local") {
        let root = titan_skills::default_registry_root();
        return Ok(Box::new(LocalRegistryAdapter::new(root)));
    }
    if let Some(path) = trimmed.strip_prefix("local:") {
        return Ok(Box::new(LocalRegistryAdapter::new(PathBuf::from(path))));
    }
    if let Some(url) = trimmed.strip_prefix("git:") {
        return Ok(Box::new(titan_skills::GitRegistryAdapter::new(url)));
    }
    if let Some(url) = trimmed.strip_prefix("http:") {
        return Ok(Box::new(titan_skills::HttpRegistryAdapter::new(url)));
    }
    bail!("unsupported skill registry source: {source}");
}

fn parse_slug_and_version(input: &str) -> (String, Option<String>) {
    match input.split_once('@') {
        Some((slug, version)) => (slug.to_string(), Some(version.to_string())),
        None => (input.to_string(), None),
    }
}

fn format_skill_scopes(scopes: &[titan_skills::SkillScope]) -> String {
    scopes
        .iter()
        .map(|scope| scope.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

fn persist_installed_skill(
    store: &MemoryStore,
    installed: &titan_skills::InstalledSkillV1,
) -> Result<()> {
    let record = titan_memory::InstalledSkillRecord {
        slug: installed.manifest.slug.clone(),
        name: installed.manifest.name.clone(),
        version: installed.manifest.version.clone(),
        description: installed.manifest.description.clone(),
        source: installed.source.clone(),
        hash: installed.hash.clone(),
        signature_status: installed.signature_status.clone(),
        scopes: format_skill_scopes(&installed.manifest.permissions.scopes),
        allowed_paths: installed.manifest.permissions.allowed_paths.join(","),
        allowed_hosts: installed.manifest.permissions.allowed_hosts.join(","),
        last_run_goal_id: None,
    };
    store.upsert_installed_skill(&record)?;
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
                autonomy_mode_name(&config.mode).to_string(),
                config.security.yolo_bypass_path_guard,
            ))?;
        }
    }
    Ok(())
}

fn run_services(bind: String, _poll_interval_ms: u64) -> Result<()> {
    let config = load_initialized_config()?;
    let db_path = config.workspace_dir.join("titan.db");
    let _store = MemoryStore::open(&db_path)?;
    let runtime = TitanGatewayRuntime::new(
        config.mode.clone(),
        config.workspace_dir.clone(),
        db_path.clone(),
    );

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .with_context(|| "failed to build async runtime for titan run")?;
    rt.block_on(run_services_async(config, bind, db_path, runtime))
}

struct DiscordHandler {
    runtime: Arc<Mutex<TitanGatewayRuntime>>,
    default_channel_id: Option<u64>,
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn ready(&self, _: SerenityContext, ready: Ready) {
        println!("discord_ready: {} ({})", ready.user.name, ready.user.id);
    }

    async fn message(&self, ctx: SerenityContext, msg: Message) {
        if msg.author.bot {
            return;
        }
        if let Some(default_channel_id) = self.default_channel_id
            && msg.channel_id.get() != default_channel_id
        {
            return;
        }

        let content = msg.content.trim().to_string();
        if content.is_empty() {
            return;
        }

        if content.starts_with('/') {
            let runtime = Arc::clone(&self.runtime);
            let actor_id = msg.author.id.to_string();
            let content_copy = content.clone();
            let command_result = tokio::task::spawn_blocking(move || {
                let lock = runtime
                    .lock()
                    .map_err(|_| anyhow::anyhow!("runtime lock poisoned"))?;
                lock.process_chat_input(InboundEvent::new(
                    GatewayChannel::Discord,
                    actor_id,
                    content_copy,
                ))
            })
            .await;

            if let Ok(Ok(reply)) = command_result {
                let _ = msg.channel_id.say(&ctx.http, reply.response).await;
            }
            return;
        }

        let normalized = content.to_ascii_lowercase();
        if !(normalized.contains("scan workspace")
            || normalized.contains("update readme")
            || normalized.contains("write ")
            || normalized.contains("read "))
        {
            return;
        }

        let runtime = Arc::clone(&self.runtime);
        let actor_id = msg.author.id.to_string();
        let content_copy = content.clone();
        let run_result = tokio::task::spawn_blocking(move || {
            let lock = runtime
                .lock()
                .map_err(|_| anyhow::anyhow!("runtime lock poisoned"))?;
            lock.process_chat_input(InboundEvent::new(
                GatewayChannel::Discord,
                actor_id,
                content_copy,
            ))
        })
        .await;

        let response = match run_result {
            Ok(Ok(outcome)) => outcome.response,
            Ok(Err(err)) => format!("run_error: {err}"),
            Err(err) => format!("runtime_join_error: {err}"),
        };
        let _ = msg.channel_id.say(&ctx.http, response).await;
    }
}

async fn run_services_async(
    config: TitanConfig,
    bind: String,
    db_path: PathBuf,
    runtime: TitanGatewayRuntime,
) -> Result<()> {
    let web_bind = bind.clone();
    let web_db = db_path.clone();
    let web_workspace = config.workspace_dir.clone();
    let web_mode = autonomy_mode_name(&config.mode).to_string();
    let web_yolo_bypass = config.security.yolo_bypass_path_guard;
    tokio::spawn(async move {
        if let Err(err) =
            web_runtime::serve(&web_bind, web_db, web_workspace, web_mode, web_yolo_bypass).await
        {
            eprintln!("web runtime stopped: {err}");
        }
    });

    println!("run_status: starting");
    println!("workspace: {}", config.workspace_dir.display());
    println!("db: {}", db_path.display());
    println!("web_bind: {}", bind);
    println!("mode: {}", autonomy_mode_name(&config.mode));
    let expiry_db = db_path.clone();
    tokio::spawn(async move {
        loop {
            if let Ok(store) = MemoryStore::open(&expiry_db) {
                let _ = store.apply_yolo_expiry("run_loop");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    if !config.discord.enabled {
        println!("discord_enabled: false");
        println!("runtime: web-only (set discord.enabled=true to enable Discord gateway)");
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    let token = resolve_discord_token(&config).ok_or_else(|| {
        anyhow::anyhow!(
            "discord token missing: set DISCORD_BOT_TOKEN or DISCORD_TOKEN or config.discord.token"
        )
    })?;
    let default_channel_id = resolve_discord_channel_id(&config);
    println!("discord_enabled: true");
    if let Some(channel_id) = default_channel_id {
        println!("discord_channel: {}", channel_id);
    }

    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;
    let handler = DiscordHandler {
        runtime: Arc::new(Mutex::new(runtime)),
        default_channel_id,
    };
    let mut client = serenity::Client::builder(token, intents)
        .event_handler(handler)
        .await
        .with_context(|| "failed to build Discord gateway client")?;
    client
        .start()
        .await
        .with_context(|| "Discord gateway client stopped unexpectedly")
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

fn auto_configure_model_defaults(config: &mut TitanConfig) -> Result<()> {
    match config.model.provider {
        ModelProvider::Ollama => {
            let endpoint = config
                .model
                .endpoint
                .clone()
                .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
            let discovered = discover_ollama_models(&endpoint)?;
            if let Some(model) = discovered.first() {
                config.model.model_id = model.clone();
            } else if config.model.model_id.trim().is_empty() {
                config.model.model_id = "llama3.2:latest".to_string();
            }
            config.model.endpoint = Some(endpoint);
            config.model.api_key_env = None;
        }
        ModelProvider::OpenAi => {
            if config.model.model_id.trim().is_empty() {
                config.model.model_id = "gpt-4o-mini".to_string();
            }
            if config.model.api_key_env.is_none() {
                config.model.api_key_env = Some("OPENAI_API_KEY".to_string());
            }
        }
        ModelProvider::Anthropic => {
            if config.model.model_id.trim().is_empty() {
                config.model.model_id = "claude-3-5-sonnet-latest".to_string();
            }
            if config.model.api_key_env.is_none() {
                config.model.api_key_env = Some("ANTHROPIC_API_KEY".to_string());
            }
        }
        ModelProvider::Custom => {
            if config.model.model_id.trim().is_empty() {
                config.model.model_id = "custom-model".to_string();
            }
        }
    }
    Ok(())
}

fn report_discord_onboarding_status(config: &TitanConfig) -> Result<()> {
    let token = resolve_discord_token(config).unwrap_or_default();
    if token.trim().is_empty() {
        println!("discord_validation: skipped (missing token)");
        return Ok(());
    }
    let channel = resolve_discord_channel_id(config);
    println!(
        "discord_channel_configured: {}",
        channel
            .map(|id| id.to_string())
            .unwrap_or_else(|| "<none>".to_string())
    );
    let gateway = DiscordGateway::new(&token, 10_000)?;
    match gateway.healthcheck() {
        Ok(identity) => {
            println!("discord_validation: ok");
            println!("discord_bot_username: {}", identity.username);
            println!("discord_bot_id: {}", identity.id);
        }
        Err(err) => {
            println!("discord_validation: failed");
            println!("discord_validation_error: {}", err);
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

fn default_connector_config(connector_type: ConnectorType) -> Result<Value> {
    let value = match connector_type {
        ConnectorType::Github => serde_json::json!({
            "owner": "",
            "repo": "",
            "base_url": "https://api.github.com",
        }),
        ConnectorType::GoogleCalendar => serde_json::json!({
            "calendar_id": "primary",
            "base_url": "https://www.googleapis.com/calendar/v3",
            "access_token_env": "GOOGLE_CALENDAR_TOKEN",
        }),
    };
    Ok(value)
}

fn maybe_unlock_secrets_store_interactive() -> Result<Option<SecretsStore>> {
    let choice = prompt_yes_no("Unlock encrypted secrets store", false)?;
    if !choice {
        return Ok(None);
    }
    let passphrase = prompt_with_default("Secrets passphrase", "")?;
    if passphrase.trim().is_empty() {
        bail!("passphrase cannot be empty");
    }
    let mut store = SecretsStore::open_default();
    store.unlock(passphrase.trim())?;
    Ok(Some(store))
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

fn autonomy_mode_name(mode: &AutonomyMode) -> &'static str {
    match mode {
        AutonomyMode::Supervised => "supervised",
        AutonomyMode::Collaborative => "collaborative",
        AutonomyMode::Autonomous => "autonomous",
    }
}

fn resolve_discord_token(config: &TitanConfig) -> Option<String> {
    std::env::var("DISCORD_BOT_TOKEN")
        .ok()
        .or_else(|| std::env::var("DISCORD_TOKEN").ok())
        .or(config.discord.token.clone())
}

fn resolve_discord_channel_from_env() -> Option<String> {
    std::env::var("DISCORD_CHANNEL_ID").ok().and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn resolve_discord_channel_id(config: &TitanConfig) -> Option<u64> {
    config
        .discord
        .default_channel_id
        .clone()
        .or_else(resolve_discord_channel_from_env)
        .and_then(|raw| raw.parse::<u64>().ok())
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
