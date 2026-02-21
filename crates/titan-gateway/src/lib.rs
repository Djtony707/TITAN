use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use titan_common::{ActivationMode, AutonomyMode, TitanConfig};
use titan_connectors::{CompositeSecretResolver, execute_connector_tool_after_approval};
use titan_core::{
    CoreEvent, Goal, GoalStatus, StepPermission, StepResult, TaskPipelineConfig, TraceEvent,
    build_task_plan, execute_task_plan_with_broker,
};
use titan_memory::{MemoryStore, RiskMode, RunPersistenceBundle};
use titan_tools::{PolicyEngine, ToolExecutionContext, ToolExecutor, ToolRegistry, ToolRiskMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Cli,
    Discord,
    Webchat,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Discord => "discord",
            Self::Webchat => "webchat",
        }
    }
}

#[derive(Debug, Clone)]
pub struct InboundEvent {
    pub channel: Channel,
    pub actor_id: String,
    pub text: String,
    pub dedupe_key: Option<String>,
}

impl InboundEvent {
    pub fn new(channel: Channel, actor_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            channel,
            actor_id: actor_id.into(),
            text: text.into(),
            dedupe_key: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProcessedEvent {
    pub session_id: String,
    pub goal_id: String,
    pub goal_status: GoalStatus,
    pub pending_approval_id: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct ChatCommandResult {
    pub session_id: String,
    pub response: String,
}

pub struct TitanGatewayRuntime {
    mode: AutonomyMode,
    workspace_root: PathBuf,
    db_path: PathBuf,
    config_path: Option<PathBuf>,
}

impl TitanGatewayRuntime {
    pub fn new(mode: AutonomyMode, workspace_root: PathBuf, db_path: PathBuf) -> Self {
        Self {
            mode,
            workspace_root,
            db_path,
            config_path: None,
        }
    }

    pub fn with_config_path(mut self, config_path: PathBuf) -> Self {
        self.config_path = Some(config_path);
        self
    }

    pub fn set_mode(&mut self, mode: AutonomyMode) {
        self.mode = mode;
    }

    pub fn mode(&self) -> AutonomyMode {
        self.mode.clone()
    }

    pub fn process_chat_input(&self, inbound: InboundEvent) -> Result<ChatCommandResult> {
        let trimmed = inbound.text.trim();
        if let Some(command) = parse_slash_command(trimmed) {
            let output = self.handle_slash_command(&inbound, &command)?;
            return Ok(output);
        }
        let event_result = self.process_event(inbound)?;
        Ok(ChatCommandResult {
            session_id: event_result.session_id,
            response: format!(
                "goal={} status={} summary={}{}",
                event_result.goal_id,
                event_result.goal_status.as_str(),
                event_result.summary,
                event_result
                    .pending_approval_id
                    .map(|id| format!(" approval_pending={id}"))
                    .unwrap_or_default()
            ),
        })
    }

    pub fn process_event(&self, inbound: InboundEvent) -> Result<ProcessedEvent> {
        let mut store = MemoryStore::open(&self.db_path)?;
        store.apply_yolo_expiry("gateway")?;
        let cfg = load_runtime_config(self.config_path.as_deref())?;
        let risk_state = store.get_runtime_risk_state()?;
        let risk_mode = risk_state.risk_mode;
        let risk_mode_str = risk_mode.as_str().to_string();
        let session =
            store.get_or_create_active_session(inbound.channel.as_str(), &inbound.actor_id)?;
        if !is_message_allowed(&inbound, &session, self.config_path.as_deref())? {
            let detail = "Message ignored by activation/allowlist policy".to_string();
            store.add_trace_event(&TraceEvent::new(
                session.id.clone(),
                "command_invoked",
                detail.clone(),
            ))?;
            return Ok(ProcessedEvent {
                session_id: session.id,
                goal_id: "policy_blocked".to_string(),
                goal_status: GoalStatus::Cancelled,
                pending_approval_id: None,
                summary: detail,
            });
        }

        store.set_session_queue_depth(&session.id, 1)?;
        store.clear_session_stop(&session.id)?;
        store.add_session_message(&session.id, "user", inbound.text.trim(), false)?;

        let registry = ToolRegistry::with_defaults();
        let mut execution_ctx =
            ToolExecutionContext::default_for_workspace(self.workspace_root.clone());
        execution_ctx.bypass_path_guard = matches!(risk_mode, RiskMode::Yolo)
            && risk_state.yolo_bypass_path_guard
            && cfg.security.yolo_bypass_path_guard;

        let goal_description = format!("[{}] {}", inbound.channel.as_str(), inbound.text.trim());
        let goal = Goal::new(goal_description).with_dedupe_key(inbound.dedupe_key.clone());
        let event = CoreEvent::new(
            inbound.channel.as_str(),
            inbound.actor_id.clone(),
            inbound.text.clone(),
        )
        .with_dedupe_key(inbound.dedupe_key.clone());
        let plan = build_task_plan(&goal.id, &event, &TaskPipelineConfig { candidate_count: 3 });
        let result = execute_task_plan_with_broker(
            goal,
            plan,
            |tool_name| {
                let class = registry.get(tool_name).map(|tool| tool.class);
                match class {
                    Some(titan_tools::CapabilityClass::Read) => Some(StepPermission::Read),
                    Some(titan_tools::CapabilityClass::Write) => Some(StepPermission::Write),
                    Some(titan_tools::CapabilityClass::Exec) => Some(StepPermission::Exec),
                    Some(titan_tools::CapabilityClass::Net) => Some(StepPermission::Net),
                    None => None,
                }
            },
            |permission| {
                let class = match permission {
                    StepPermission::Read => titan_tools::CapabilityClass::Read,
                    StepPermission::Write => titan_tools::CapabilityClass::Write,
                    StepPermission::Exec => titan_tools::CapabilityClass::Exec,
                    StepPermission::Net => titan_tools::CapabilityClass::Net,
                };
                let risk = if matches!(risk_mode, RiskMode::Yolo) {
                    ToolRiskMode::Yolo
                } else {
                    ToolRiskMode::Secure
                };
                PolicyEngine::requires_approval_with_risk(self.mode.clone(), risk, class)
            },
            |step| {
                let tool = registry
                    .get(&step.tool_name)
                    .ok_or_else(|| format!("unknown tool '{}'", step.tool_name))?;
                let tool_result =
                    ToolExecutor::execute(tool, step.input.as_deref(), &execution_ctx)
                        .map_err(|err| err.to_string())?;
                Ok(StepResult {
                    step_id: step.id.clone(),
                    tool_name: step.tool_name.to_string(),
                    status: tool_result.status,
                    output: tool_result.output,
                })
            },
        );
        let mut run = result;
        for trace in &mut run.traces {
            trace.risk_mode = risk_mode.as_str().to_string();
        }
        run.traces.insert(
            0,
            TraceEvent::new(run.goal.id.clone(), "goal_submitted", inbound.text.clone())
                .with_risk_mode(risk_mode_str.clone()),
        );
        run.traces.insert(
            1,
            TraceEvent::new(
                run.goal.id.clone(),
                "event_received",
                format!(
                    "source={} actor={}",
                    inbound.channel.as_str(),
                    inbound.actor_id
                ),
            )
            .with_risk_mode(risk_mode_str),
        );
        store.create_goal_for_session(&run.goal, Some(&session.id))?;
        let persisted = store.persist_run_bundle(RunPersistenceBundle {
            run: &run,
            source: inbound.channel.as_str(),
            requested_by: Some(inbound.actor_id.as_str()),
            approval_ttl_ms: 300_000,
        })?;
        store.set_session_queue_depth(&session.id, 0)?;
        store.add_session_message(&session.id, "assistant", &run.reflection, false)?;
        let pending_approval_id = persisted.approval_id;

        Ok(ProcessedEvent {
            session_id: session.id,
            goal_id: run.goal.id,
            goal_status: run.goal.status,
            pending_approval_id,
            summary: run.reflection,
        })
    }

    fn handle_slash_command(
        &self,
        inbound: &InboundEvent,
        command: &str,
    ) -> Result<ChatCommandResult> {
        let store = MemoryStore::open(&self.db_path)?;
        let mut session =
            store.get_or_create_active_session(inbound.channel.as_str(), &inbound.actor_id)?;
        let trace_goal_id = store.last_goal_for_session(&session.id)?;
        if let Some(goal_id) = trace_goal_id.as_deref() {
            store.add_trace_event(&TraceEvent::new(
                goal_id.to_string(),
                "command_invoked",
                format!("{} {}", inbound.channel.as_str(), command),
            ))?;
        }

        let mut parts = command.split_whitespace();
        let head = parts.next().unwrap_or_default();
        let args: Vec<&str> = parts.collect();

        let response = match head {
            "/help" => slash_help(),
            "/status" => {
                let cfg = load_runtime_config(self.config_path.as_deref())?;
                let risk = store.get_runtime_risk_state()?;
                let pending = store.list_pending_approvals()?.len();
                let last_run = store
                    .last_goal_for_session(&session.id)?
                    .unwrap_or_else(|| "<none>".to_string());
                format!(
                    "mode={} provider={} model={} session_id={} last_run_id={} compactions={} pending_approvals={} queue_depth={} risk_mode={} yolo_expires_at_ms={}",
                    match self.mode {
                        AutonomyMode::Supervised => "supervised",
                        AutonomyMode::Collaborative => "collaborative",
                        AutonomyMode::Autonomous => "autonomous",
                    },
                    model_provider_name(&cfg.model.provider),
                    session.model_override.clone().unwrap_or(cfg.model.model_id),
                    session.id,
                    last_run,
                    session.compactions_count,
                    pending,
                    session.queue_depth,
                    risk.risk_mode.as_str(),
                    risk.yolo_expires_at_ms
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<none>".to_string())
                )
            }
            "/mode" => {
                if args.len() != 1 {
                    "usage: /mode supervised|collab|auto".to_string()
                } else {
                    let selected = match args[0].trim().to_ascii_lowercase().as_str() {
                        "supervised" => Some(AutonomyMode::Supervised),
                        "collab" | "collaborative" => Some(AutonomyMode::Collaborative),
                        "auto" | "autonomous" => Some(AutonomyMode::Autonomous),
                        _ => None,
                    };
                    if let Some(mode) = selected {
                        let (mut cfg, path, _) =
                            load_runtime_config_with_path(self.config_path.as_deref())
                                .map_err(|err| anyhow!("{err}"))?;
                        cfg.mode = mode.clone();
                        cfg.save(&path).map_err(|err| anyhow!("{err}"))?;
                        format!(
                            "mode_updated={}",
                            match mode {
                                AutonomyMode::Supervised => "supervised",
                                AutonomyMode::Collaborative => "collaborative",
                                AutonomyMode::Autonomous => "autonomous",
                            }
                        )
                    } else {
                        "usage: /mode supervised|collab|auto".to_string()
                    }
                }
            }
            "/new" | "/reset" => {
                let model_or_text = args.first().map(|s| s.to_string());
                session = store.create_session(
                    inbound.channel.as_str(),
                    &inbound.actor_id,
                    model_or_text.as_deref(),
                )?;
                format!(
                    "session_reset: {} model={}",
                    session.id,
                    session
                        .model_override
                        .unwrap_or_else(|| "<default>".to_string())
                )
            }
            "/compact" => {
                let instructions = if args.is_empty() {
                    None
                } else {
                    Some(args.join(" "))
                };
                let compacted = store.compact_session(&session.id, instructions.as_deref())?;
                let refreshed = store.get_session(&session.id)?.unwrap_or(session.clone());
                session = refreshed;
                format!(
                    "session_compacted: {} messages_compacted={} compactions={}",
                    session.id, compacted, session.compactions_count
                )
            }
            "/stop" => {
                store.mark_session_stop(&session.id)?;
                "session_stop_requested: true".to_string()
            }
            "/approve" => {
                if args.len() != 1 {
                    "usage: /approve <approval_id>".to_string()
                } else {
                    let status = self.resolve_approval(
                        args[0],
                        true,
                        inbound.actor_id.as_str(),
                        Some("chat approve"),
                    )?;
                    format!("approval_status={status}")
                }
            }
            "/deny" => {
                if args.len() != 1 {
                    "usage: /deny <approval_id>".to_string()
                } else {
                    let status = self.resolve_approval(
                        args[0],
                        false,
                        inbound.actor_id.as_str(),
                        Some("chat deny"),
                    )?;
                    format!("approval_status={status}")
                }
            }
            "/trace" => {
                if args.first().copied() == Some("last") {
                    let rows = store.list_recent_traces(1)?;
                    if let Some(trace) = rows.first() {
                        format!(
                            "trace_last goal={} type={} detail={}",
                            trace.goal_id, trace.event_type, trace.detail
                        )
                    } else {
                        "trace_last none".to_string()
                    }
                } else {
                    "usage: /trace last".to_string()
                }
            }
            "/usage" => {
                if args.is_empty() {
                    format!("usage_mode={}", session.usage_mode)
                } else {
                    let mode = args[0];
                    if !matches!(mode, "off" | "tokens" | "full") {
                        "usage: /usage off|tokens|full".to_string()
                    } else {
                        store.set_session_usage_mode(&session.id, mode)?;
                        format!("usage_mode_updated={mode}")
                    }
                }
            }
            "/context" => {
                if args.first().copied() == Some("detail") {
                    let rows = store.list_session_messages(&session.id, 20)?;
                    let mut out = format!("context_detail session={}\n", session.id);
                    for row in rows {
                        out.push_str(&format!(
                            "#{} {} compacted={} bytes={}\n",
                            row.id,
                            row.role,
                            row.compacted,
                            row.content.len()
                        ));
                    }
                    out
                } else {
                    let rows = store.list_session_messages(&session.id, 20)?;
                    let total: usize = rows.iter().map(|r| r.content.len()).sum();
                    format!(
                        "context_list session={} items={} bytes={}",
                        session.id,
                        rows.len(),
                        total
                    )
                }
            }
            "/model" => self.handle_model_command(&store, &session.id, &args)?,
            "/yolo" => {
                "YOLO mode can only be enabled from local CLI via `titan yolo ...`".to_string()
            }
            "/skill" => self.handle_skill_command(&store, &args, inbound.actor_id.as_str())?,
            "/allowlist" => self.handle_allowlist_command(inbound, &store, &session, &args)?,
            "/activation" => self.handle_activation_command(inbound, &store, &session, &args)?,
            _ => "unknown command. try /help".to_string(),
        };
        if let Some(goal_id) = trace_goal_id.as_deref() {
            store.add_trace_event(&TraceEvent::new(
                goal_id.to_string(),
                "command_outcome",
                response.clone(),
            ))?;
        }
        Ok(ChatCommandResult {
            session_id: session.id,
            response,
        })
    }

    fn handle_model_command(
        &self,
        store: &MemoryStore,
        session_id: &str,
        args: &[&str],
    ) -> Result<String> {
        let cfg = load_runtime_config(self.config_path.as_deref())?;
        if args.is_empty() || args[0] == "status" {
            let session = store
                .get_session(session_id)?
                .ok_or_else(|| anyhow!("session not found"))?;
            let active_model = session
                .model_override
                .unwrap_or_else(|| cfg.model.model_id.clone());
            return Ok(format!(
                "provider={} model={}",
                model_provider_name(&cfg.model.provider),
                active_model
            ));
        }
        if args[0] == "list" {
            return Ok(format!("model_list: {}", cfg.model.model_id));
        }
        let selection = args.join(" ");
        store.set_session_model_override(session_id, Some(selection.trim()))?;
        Ok(format!("model_override_updated={}", selection.trim()))
    }

    fn handle_allowlist_command(
        &self,
        inbound: &InboundEvent,
        store: &MemoryStore,
        _session: &titan_memory::SessionRecord,
        args: &[&str],
    ) -> Result<String> {
        if args.len() < 2 {
            return Ok("usage: /allowlist add|remove <id>".to_string());
        }
        let action = args[0];
        let id = args[1].trim();
        if id.is_empty() {
            return Ok("usage: /allowlist add|remove <id>".to_string());
        }
        if requires_config_approval(self.mode.clone()) {
            let approval = store.create_approval_request_for_goal(
                None,
                "config_allowlist",
                "write",
                &format!("{action}:{id}"),
                Some(inbound.actor_id.as_str()),
                300_000,
            )?;
            return Ok(format!(
                "approval_required=true approval_id={}",
                approval.id
            ));
        }
        apply_allowlist_change(action, id, self.config_path.as_deref())?;
        Ok(format!("allowlist_updated action={action} id={id}"))
    }

    fn handle_skill_command(
        &self,
        store: &MemoryStore,
        args: &[&str],
        actor_id: &str,
    ) -> Result<String> {
        if args.len() < 2 || args[0] != "install" {
            return Ok("usage: /skill install <slug>[@version]".to_string());
        }
        let (slug, version) = parse_slug_and_version(args[1]);
        let registry_root = self.workspace_root.join(".titan/registry/local");
        let adapter = titan_skills::LocalRegistryAdapter::new(registry_root);
        let staged = titan_skills::stage_install_v1(
            &adapter,
            &self.workspace_root,
            &slug,
            version.as_deref(),
            false,
        )?;
        titan_skills::deny_unsigned_risky_install(&staged)?;
        let payload = titan_skills::approval_payload_for_stage(&staged);
        let payload_json = titan_skills::serialize_approval_payload(&payload)?;
        let approval = store.create_approval_request(
            "skill_install",
            "write",
            &payload_json,
            Some(actor_id),
            300_000,
        )?;
        Ok(format!(
            "approval_required=true approval_id={} skill={}@{} signed={} scopes={} allowed_paths={} allowed_hosts={}",
            approval.id,
            payload.slug,
            payload.version,
            payload.signature_status,
            payload.scopes.join(","),
            payload.allowed_paths.join(","),
            payload.allowed_hosts.join(",")
        ))
    }

    fn handle_activation_command(
        &self,
        inbound: &InboundEvent,
        store: &MemoryStore,
        _session: &titan_memory::SessionRecord,
        args: &[&str],
    ) -> Result<String> {
        if args.len() != 1 {
            return Ok("usage: /activation mention|always".to_string());
        }
        let mode = args[0].trim().to_ascii_lowercase();
        if mode != "mention" && mode != "always" {
            return Ok("usage: /activation mention|always".to_string());
        }
        if requires_config_approval(self.mode.clone()) {
            let approval = store.create_approval_request_for_goal(
                None,
                "config_activation",
                "write",
                &mode,
                Some(inbound.actor_id.as_str()),
                300_000,
            )?;
            return Ok(format!(
                "approval_required=true approval_id={}",
                approval.id
            ));
        }
        apply_activation_mode(&mode, self.config_path.as_deref())?;
        Ok(format!("activation_mode_updated={mode}"))
    }

    pub fn resolve_approval(
        &self,
        approval_id: &str,
        approved: bool,
        resolved_by: &str,
        reason: Option<&str>,
    ) -> Result<String> {
        let store = MemoryStore::open(&self.db_path)?;
        store.apply_yolo_expiry("gateway")?;
        let cfg = load_runtime_config(self.config_path.as_deref())?;
        let approval = store
            .get_approval_request(approval_id)?
            .ok_or_else(|| anyhow!("approval not found: {approval_id}"))?;

        let resolved =
            store.resolve_approval_request(approval_id, approved, Some(resolved_by), reason)?;
        if !resolved {
            return Ok("not_pending".to_string());
        }

        if !approved {
            if let Some(goal_id) = approval.goal_id {
                store.update_goal_status(&goal_id, GoalStatus::Cancelled)?;
                store.add_trace_event(&TraceEvent::new(
                    goal_id.clone(),
                    "approval_denied",
                    approval_id.to_string(),
                ))?;
                store.add_episodic_memory(&goal_id, "Approval denied by operator", "discord")?;
            }
            return Ok("denied".to_string());
        }

        if store.approval_has_tool_run(approval_id)? {
            return Ok("replay_blocked".to_string());
        }

        if approval.tool_name == "config_allowlist" {
            let (action, value) = approval
                .input
                .split_once(':')
                .ok_or_else(|| anyhow!("invalid config_allowlist approval payload"))?;
            apply_allowlist_change(action, value, self.config_path.as_deref())?;
            return Ok("approved".to_string());
        }
        if approval.tool_name == "config_activation" {
            apply_activation_mode(approval.input.trim(), self.config_path.as_deref())?;
            return Ok("approved".to_string());
        }
        if approval.tool_name == "skill_install" {
            let payload = titan_skills::deserialize_approval_payload(&approval.input)?;
            let installed = titan_skills::finalize_install_from_payload(&payload)?;
            let installed_ref =
                format!("{}@{}", installed.manifest.slug, installed.manifest.version);
            store.upsert_installed_skill(&titan_memory::InstalledSkillRecord {
                slug: installed.manifest.slug.clone(),
                name: installed.manifest.name.clone(),
                version: installed.manifest.version.clone(),
                description: installed.manifest.description.clone(),
                source: installed.source.clone(),
                hash: installed.hash.clone(),
                signature_status: installed.signature_status.clone(),
                scopes: installed
                    .manifest
                    .permissions
                    .scopes
                    .iter()
                    .map(|scope| scope.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
                allowed_paths: installed.manifest.permissions.allowed_paths.join(","),
                allowed_hosts: installed.manifest.permissions.allowed_hosts.join(","),
                last_run_goal_id: None,
            })?;
            return Ok(format!("approved installed={installed_ref}"));
        }
        if approval.tool_name == "skill_exec_grant" {
            return Ok("approved".to_string());
        }
        if approval.tool_name == "connector_tool" {
            let resolver = CompositeSecretResolver::from_env()?;
            let outcome = execute_connector_tool_after_approval(
                &store,
                resolved_by,
                &approval.input,
                &resolver,
            )?;
            return Ok(format!(
                "approved connector_goal={} status={}",
                outcome.goal_id, outcome.result_status
            ));
        }

        let registry = ToolRegistry::with_defaults();
        let tool = registry
            .get(&approval.tool_name)
            .ok_or_else(|| anyhow!("unknown tool '{}'", approval.tool_name))?;
        let input_ref = if approval.input.trim().is_empty() {
            None
        } else {
            Some(approval.input.as_str())
        };
        let mut exec_ctx = ToolExecutionContext::default_for_workspace(self.workspace_root.clone());
        let risk = store.get_runtime_risk_state()?;
        exec_ctx.bypass_path_guard = matches!(risk.risk_mode, RiskMode::Yolo)
            && risk.yolo_bypass_path_guard
            && cfg.security.yolo_bypass_path_guard;
        let result = ToolExecutor::execute(tool, input_ref, &exec_ctx)
            .with_context(|| format!("approved tool '{}' execution failed", tool.name))?;
        store.record_tool_run(
            Some(approval_id),
            &tool.name,
            &result.status,
            &result.output,
        )?;
        if let Some(goal_id) = approval.goal_id {
            store.mark_blocked_step_executed_for_goal(&goal_id, &tool.name, &result.output)?;
            store.add_trace_event(&TraceEvent::new(
                goal_id.clone(),
                "approval_executed",
                format!("{} -> {}", tool.name, result.status),
            ))?;
            store.add_trace_event(&TraceEvent::new(
                goal_id.clone(),
                "write_diff",
                format!("tool_output={}", result.output),
            ))?;
            store.update_goal_status(&goal_id, GoalStatus::Completed)?;
            store.add_episodic_memory(
                &goal_id,
                "Approval executed and write step completed",
                "discord",
            )?;
        }
        Ok("approved".to_string())
    }
}

fn parse_slash_command(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.starts_with("/titan ") {
        let cmd = trimmed.trim_start_matches("/titan").trim();
        return Some(format!("/{cmd}"));
    }
    if trimmed.starts_with('/') {
        return Some(trimmed.to_string());
    }
    None
}

fn slash_help() -> String {
    [
        "commands:",
        "/status",
        "/mode supervised|collab|auto",
        "/new [model?]",
        "/reset",
        "/compact [instructions?]",
        "/stop",
        "/approve <approval_id>",
        "/deny <approval_id>",
        "/trace last",
        "/model",
        "/model list",
        "/model status",
        "/yolo (cli-only)",
        "/skill install <slug>[@version]",
        "/usage off|tokens|full",
        "/context list|detail",
        "/allowlist add|remove <id>",
        "/activation mention|always",
        "/help",
    ]
    .join("\n")
}

fn load_runtime_config(config_path: Option<&std::path::Path>) -> Result<TitanConfig> {
    let (cfg, _, _) = load_runtime_config_with_path(config_path)?;
    Ok(cfg)
}

fn load_runtime_config_with_path(
    config_path: Option<&std::path::Path>,
) -> Result<(TitanConfig, PathBuf, bool)> {
    if let Some(path) = config_path {
        if path.exists() {
            let cfg = TitanConfig::load(path).map_err(|err| anyhow!("{err}"))?;
            Ok((cfg, path.to_path_buf(), false))
        } else {
            let cfg = TitanConfig::default();
            cfg.save(path).map_err(|err| anyhow!("{err}"))?;
            Ok((cfg, path.to_path_buf(), true))
        }
    } else {
        TitanConfig::load_or_create().map_err(|err| anyhow!("{err}"))
    }
}

fn model_provider_name(provider: &titan_common::ModelProvider) -> &'static str {
    match provider {
        titan_common::ModelProvider::OpenAi => "openai",
        titan_common::ModelProvider::Anthropic => "anthropic",
        titan_common::ModelProvider::Ollama => "ollama",
        titan_common::ModelProvider::Custom => "custom",
    }
}

fn requires_config_approval(mode: AutonomyMode) -> bool {
    !matches!(mode, AutonomyMode::Autonomous)
}

fn apply_allowlist_change(
    action: &str,
    value: &str,
    config_path: Option<&std::path::Path>,
) -> Result<()> {
    let (mut cfg, path, _) = load_runtime_config_with_path(config_path)?;
    let mut allowlist: std::collections::BTreeSet<String> =
        cfg.chat.allowlist.into_iter().collect();
    match action {
        "add" => {
            allowlist.insert(value.trim().to_string());
        }
        "remove" => {
            allowlist.remove(value.trim());
        }
        _ => return Err(anyhow!("unknown allowlist action: {action}")),
    }
    cfg.chat.allowlist = allowlist.into_iter().collect();
    cfg.save(&path).map_err(|err| anyhow!("{err}"))?;
    Ok(())
}

fn apply_activation_mode(mode: &str, config_path: Option<&std::path::Path>) -> Result<()> {
    let (mut cfg, path, _) = load_runtime_config_with_path(config_path)?;
    cfg.chat.activation_mode = match mode.trim().to_ascii_lowercase().as_str() {
        "always" => ActivationMode::Always,
        "mention" => ActivationMode::Mention,
        _ => return Err(anyhow!("invalid activation mode: {mode}")),
    };
    cfg.save(&path).map_err(|err| anyhow!("{err}"))?;
    Ok(())
}

fn is_message_allowed(
    inbound: &InboundEvent,
    session: &titan_memory::SessionRecord,
    config_path: Option<&std::path::Path>,
) -> Result<bool> {
    let cfg = load_runtime_config(config_path)?;
    if !cfg.chat.allowlist.is_empty()
        && !cfg.chat.allowlist.iter().any(|id| id == &inbound.actor_id)
    {
        return Ok(false);
    }
    let session_mode = session.activation_mode.to_ascii_lowercase();
    let effective_mode = if session_mode == "mention" {
        ActivationMode::Mention
    } else {
        cfg.chat.activation_mode
    };
    if matches!(effective_mode, ActivationMode::Mention) {
        let lowered = inbound.text.to_ascii_lowercase();
        if !lowered.contains("titan") && !inbound.text.contains('/') {
            return Ok(false);
        }
    }
    Ok(true)
}

fn parse_slug_and_version(input: &str) -> (String, Option<String>) {
    match input.split_once('@') {
        Some((slug, version)) => (slug.to_string(), Some(version.to_string())),
        None => (input.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_test_config(workspace: &std::path::Path) -> std::path::PathBuf {
        let mut cfg = TitanConfig {
            workspace_dir: workspace.to_path_buf(),
            ..TitanConfig::default()
        };
        cfg.chat.activation_mode = ActivationMode::Always;
        let tmp = workspace.join("test-config.toml");
        cfg.save(&tmp).expect("save config");
        tmp
    }

    fn seed_local_registry_skill(workspace: &std::path::Path, slug: &str, version: &str) {
        let bundle = workspace
            .join(".titan/registry/local/bundles")
            .join(format!("{slug}-{version}"));
        std::fs::create_dir_all(&bundle).expect("bundle dir");
        std::fs::write(bundle.join("SKILL.md"), "# skill\n").expect("skill docs");
        std::fs::write(
            bundle.join("skill.toml"),
            format!(
                r#"name = "{slug}"
slug = "{slug}"
version = "{version}"
description = "demo"
entrypoint_type = "prompt"
entrypoint = "tool:list_dir ."

[permissions]
scopes = ["READ"]
allowed_paths = ["."]
allowed_hosts = []
"#
            ),
        )
        .expect("skill manifest");
        let hash = titan_skills::compute_bundle_hash(&bundle).expect("bundle hash");
        let index = format!(
            r#"{{
  "skills": [
    {{
      "slug": "{slug}",
      "name": "{slug}",
      "latest": "{version}",
      "versions": [
        {{
          "version": "{version}",
          "download_url": "bundles/{slug}-{version}",
          "sha256": "{hash}"
        }}
      ]
    }}
  ]
}}"#
        );
        let index_path = workspace.join(".titan/registry/local/index.json");
        std::fs::create_dir_all(index_path.parent().expect("parent")).expect("registry root");
        std::fs::write(index_path, index).expect("index");
    }

    #[test]
    fn injected_read_event_executes_and_persists_trace_and_memory() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "hello").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");

        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let outcome = runtime
            .process_event(InboundEvent::new(Channel::Discord, "u1", "scan workspace"))
            .expect("process event");
        assert!(outcome.pending_approval_id.is_none());

        let store = MemoryStore::open(&db_path).expect("open store");
        let traces = store.get_traces(&outcome.goal_id).expect("traces");
        assert!(
            traces
                .iter()
                .any(|trace| trace.event_type == "execution_started")
        );
        assert_eq!(
            store
                .count_plans_for_goal(&outcome.goal_id)
                .expect("plan rows"),
            1
        );
        assert!(
            store
                .count_steps_for_goal(&outcome.goal_id)
                .expect("step rows")
                >= 1
        );
        let memories = store.list_episodic_memory(10).expect("memories");
        assert!(
            memories
                .iter()
                .any(|entry| entry.goal_id == outcome.goal_id)
        );
        println!(
            "run_proof goal_id={} traces={} plans={} steps={} episodic={}",
            outcome.goal_id,
            traces.len(),
            store
                .count_plans_for_goal(&outcome.goal_id)
                .expect("plan rows"),
            store
                .count_steps_for_goal(&outcome.goal_id)
                .expect("step rows"),
            memories.len()
        );
    }

    #[test]
    fn collaborative_write_requires_approval_then_executes_after_approve() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");

        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let outcome = runtime
            .process_event(InboundEvent::new(
                Channel::Discord,
                "u1",
                "update README with install steps",
            ))
            .expect("process event");
        let approval_id = outcome.pending_approval_id.expect("approval id");

        assert!(
            !std::fs::read_to_string(workspace.join("README.md"))
                .expect("read readme")
                .contains("Install Steps (Generated)")
        );
        let status = runtime
            .resolve_approval(&approval_id, true, "test", Some("approved in test"))
            .expect("resolve approval");
        assert_eq!(status, "approved");
        assert!(
            std::fs::read_to_string(workspace.join("README.md"))
                .expect("read readme")
                .contains("Install Steps (Generated)")
        );

        let store = MemoryStore::open(&db_path).expect("open store");
        let traces = store.get_traces(&outcome.goal_id).expect("traces");
        assert!(
            traces
                .iter()
                .any(|trace| trace.event_type == "approval_queued")
        );
        assert!(
            traces
                .iter()
                .any(|trace| trace.event_type == "approval_executed")
        );
        let memories = store.list_episodic_memory(10).expect("memories");
        assert!(
            memories
                .iter()
                .any(|entry| entry.goal_id == outcome.goal_id)
        );
        println!(
            "approval_proof goal_id={} approval_id={} traces={} episodic={} readme_updated={}",
            outcome.goal_id,
            approval_id,
            traces.len(),
            memories.len(),
            std::fs::read_to_string(workspace.join("README.md"))
                .expect("read readme")
                .contains("Install Steps (Generated)")
        );
    }

    #[test]
    fn slash_status_reports_expected_fields() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let out = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "/status"))
            .expect("status");
        assert!(out.response.contains("mode="));
        assert!(out.response.contains("session_id="));
        assert!(out.response.contains("pending_approvals="));
    }

    #[test]
    fn slash_new_and_compact_and_stop_mutate_session_state() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let _ = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "scan workspace"))
            .expect("run1");
        let status1 = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "/status"))
            .expect("status1");
        let session_id_old = status1
            .response
            .split_whitespace()
            .find(|part| part.starts_with("session_id="))
            .and_then(|part| part.split_once('=').map(|(_, v)| v.to_string()))
            .expect("session id");

        let _ = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "/new"))
            .expect("new");
        let status2 = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "/status"))
            .expect("status2");
        let session_id_new = status2
            .response
            .split_whitespace()
            .find(|part| part.starts_with("session_id="))
            .and_then(|part| part.split_once('=').map(|(_, v)| v.to_string()))
            .expect("session id");
        assert_ne!(session_id_old, session_id_new);

        let _ = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "scan workspace"))
            .expect("run2");
        let compact = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "/compact"))
            .expect("compact");
        assert!(compact.response.contains("session_compacted"));
        let stop = runtime
            .process_chat_input(InboundEvent::new(Channel::Discord, "u1", "/stop"))
            .expect("stop");
        assert!(stop.response.contains("session_stop_requested"));
    }

    #[test]
    fn webchat_slash_is_intercepted_not_routed_as_goal() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let out = runtime
            .process_chat_input(InboundEvent::new(Channel::Webchat, "web-user", "/status"))
            .expect("web status");
        assert!(out.response.contains("session_id="));
        let store = MemoryStore::open(&db_path).expect("store");
        let session = store
            .get_or_create_active_session("webchat", "web-user")
            .expect("session");
        let last_goal = store
            .last_goal_for_session(&session.id)
            .expect("last goal for session");
        assert!(last_goal.is_none());
    }

    #[test]
    fn chat_skill_install_creates_approval_then_finalizes_on_approve() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        seed_local_registry_skill(&workspace, "list-docs", "1.0.0");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);

        let out = runtime
            .process_chat_input(InboundEvent::new(
                Channel::Discord,
                "u1",
                "/titan skill install list-docs@1.0.0",
            ))
            .expect("skill install command");
        assert!(out.response.contains("approval_required=true"));
        let approval_id = out
            .response
            .split_whitespace()
            .find(|part| part.starts_with("approval_id="))
            .and_then(|part| part.split_once('=').map(|(_, value)| value.to_string()))
            .expect("approval id");

        let approval_status = runtime
            .process_chat_input(InboundEvent::new(
                Channel::Discord,
                "u1",
                format!("/approve {approval_id}"),
            ))
            .expect("approve");
        assert!(
            approval_status
                .response
                .contains("installed=list-docs@1.0.0")
        );
        let store = MemoryStore::open(&db_path).expect("store");
        let installed = store
            .get_installed_skill("list-docs")
            .expect("installed lookup")
            .expect("installed row");
        assert_eq!(installed.version, "1.0.0");
    }

    #[test]
    fn secure_mode_blocks_write_in_collab() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let outcome = runtime
            .process_event(InboundEvent::new(
                Channel::Discord,
                "u1",
                "update README with install steps",
            ))
            .expect("run");
        assert!(outcome.pending_approval_id.is_some());
    }

    #[test]
    fn yolo_allows_write_without_approval_and_traces() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let store = MemoryStore::open(&db_path).expect("store");
        let _ = store.get_runtime_risk_state().expect("risk state");
        store.enable_yolo("cli", 15).expect("enable yolo");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let outcome = runtime
            .process_event(InboundEvent::new(
                Channel::Discord,
                "u1",
                "update README with install steps",
            ))
            .expect("run");
        assert!(outcome.pending_approval_id.is_none());
        let readme = std::fs::read_to_string(workspace.join("README.md")).expect("readme");
        assert!(readme.contains("Install Steps (Generated)"));
        let traces = MemoryStore::open(&db_path)
            .expect("store")
            .get_traces(&outcome.goal_id)
            .expect("traces");
        assert!(traces.iter().any(|trace| trace.risk_mode == "yolo"));
    }

    #[test]
    fn yolo_cannot_be_enabled_from_discord_or_web() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let discord = runtime
            .process_chat_input(InboundEvent::new(
                Channel::Discord,
                "u1",
                "/titan yolo enable abc I_ACCEPT_UNBOUNDED_AUTONOMY",
            ))
            .expect("discord yolo");
        assert!(discord.response.contains("local CLI"));
        let web = runtime
            .process_chat_input(InboundEvent::new(
                Channel::Webchat,
                "u1",
                "/yolo enable abc I_ACCEPT_UNBOUNDED_AUTONOMY",
            ))
            .expect("web yolo");
        assert!(web.response.contains("local CLI"));
    }

    #[test]
    fn yolo_auto_expires() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let store = MemoryStore::open(&db_path).expect("store");
        let _ = store.get_runtime_risk_state().expect("risk");
        store.enable_yolo("cli", 15).expect("yolo on");
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        store
            .set_yolo_expiry_at_ms(now_ms.saturating_sub(1))
            .expect("expire");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let outcome = runtime
            .process_event(InboundEvent::new(
                Channel::Discord,
                "u1",
                "update README with install steps",
            ))
            .expect("run");
        assert!(outcome.pending_approval_id.is_some());
        let state = MemoryStore::open(&db_path)
            .expect("store")
            .get_runtime_risk_state()
            .expect("risk");
        assert!(matches!(state.risk_mode, RiskMode::Secure));
    }

    #[test]
    fn traces_include_risk_mode() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "seed").expect("seed readme");
        let config_path = write_test_config(&workspace);
        let db_path = workspace.join("titan.db");
        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        )
        .with_config_path(config_path);
        let outcome = runtime
            .process_event(InboundEvent::new(Channel::Discord, "u1", "scan workspace"))
            .expect("run");
        let traces = MemoryStore::open(&db_path)
            .expect("store")
            .get_traces(&outcome.goal_id)
            .expect("traces");
        assert!(!traces.is_empty());
        assert!(
            traces
                .iter()
                .all(|trace| !trace.risk_mode.trim().is_empty())
        );
    }
}
