use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use titan_common::AutonomyMode;
use titan_core::{
    CoreEvent, Goal, GoalStatus, StepPermission, StepResult, TaskPipelineConfig, TraceEvent,
    build_task_plan, execute_task_plan_with_broker,
};
use titan_memory::{MemoryStore, RunPersistenceBundle};
use titan_tools::{PolicyEngine, ToolExecutionContext, ToolExecutor, ToolRegistry};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Cli,
    Discord,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Discord => "discord",
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
    pub goal_id: String,
    pub goal_status: GoalStatus,
    pub pending_approval_id: Option<String>,
    pub summary: String,
}

pub struct TitanGatewayRuntime {
    mode: AutonomyMode,
    workspace_root: PathBuf,
    db_path: PathBuf,
}

impl TitanGatewayRuntime {
    pub fn new(mode: AutonomyMode, workspace_root: PathBuf, db_path: PathBuf) -> Self {
        Self {
            mode,
            workspace_root,
            db_path,
        }
    }

    pub fn set_mode(&mut self, mode: AutonomyMode) {
        self.mode = mode;
    }

    pub fn mode(&self) -> AutonomyMode {
        self.mode.clone()
    }

    pub fn process_event(&self, inbound: InboundEvent) -> Result<ProcessedEvent> {
        let mut store = MemoryStore::open(&self.db_path)?;
        let registry = ToolRegistry::with_defaults();
        let execution_ctx =
            ToolExecutionContext::default_for_workspace(self.workspace_root.clone());

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
                PolicyEngine::requires_approval(self.mode.clone(), class)
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
        run.traces.insert(
            0,
            TraceEvent::new(run.goal.id.clone(), "goal_submitted", inbound.text.clone()),
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
            ),
        );
        let persisted = store.persist_run_bundle(RunPersistenceBundle {
            run: &run,
            source: inbound.channel.as_str(),
            requested_by: Some(inbound.actor_id.as_str()),
            approval_ttl_ms: 300_000,
        })?;
        let pending_approval_id = persisted.approval_id;

        Ok(ProcessedEvent {
            goal_id: run.goal.id,
            goal_status: run.goal.status,
            pending_approval_id,
            summary: run.reflection,
        })
    }

    pub fn resolve_approval(
        &self,
        approval_id: &str,
        approved: bool,
        resolved_by: &str,
        reason: Option<&str>,
    ) -> Result<String> {
        let store = MemoryStore::open(&self.db_path)?;
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

        let registry = ToolRegistry::with_defaults();
        let tool = registry
            .get(&approval.tool_name)
            .ok_or_else(|| anyhow!("unknown tool '{}'", approval.tool_name))?;
        let input_ref = if approval.input.trim().is_empty() {
            None
        } else {
            Some(approval.input.as_str())
        };
        let exec_ctx = ToolExecutionContext::default_for_workspace(self.workspace_root.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn injected_read_event_executes_and_persists_trace_and_memory() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("README.md"), "hello").expect("seed readme");
        let db_path = workspace.join("titan.db");

        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        );
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
        let db_path = workspace.join("titan.db");

        let runtime = TitanGatewayRuntime::new(
            AutonomyMode::Collaborative,
            workspace.clone(),
            db_path.clone(),
        );
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
}
