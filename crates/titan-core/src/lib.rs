use std::collections::{HashSet, VecDeque};

use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RuntimeState {
    #[default]
    Idle,
    Running,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalStatus {
    Pending,
    Planning,
    Executing,
    Completed,
    Failed,
    Cancelled,
}

impl GoalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Planning => "planning",
            Self::Executing => "executing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Goal {
    pub id: String,
    pub description: String,
    pub status: GoalStatus,
    pub dedupe_key: Option<String>,
}

impl Goal {
    pub fn new(description: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            description: description.into(),
            status: GoalStatus::Pending,
            dedupe_key: None,
        }
    }

    pub fn with_dedupe_key(mut self, dedupe_key: Option<String>) -> Self {
        self.dedupe_key = dedupe_key.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        self
    }
}

#[derive(Debug, Clone)]
pub struct TraceEvent {
    pub goal_id: String,
    pub event_type: String,
    pub detail: String,
}

impl TraceEvent {
    pub fn new(
        goal_id: impl Into<String>,
        event_type: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            goal_id: goal_id.into(),
            event_type: event_type.into(),
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalAttemptBehavior {
    Succeed,
    Fail,
    Timeout,
}

impl GoalAttemptBehavior {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("success").trim().to_lowercase().as_str() {
            "fail" => Self::Fail,
            "timeout" => Self::Timeout,
            _ => Self::Succeed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoalExecutionConfig {
    pub max_retries: u8,
    pub attempt_timeout_ms: u64,
}

impl Default for GoalExecutionConfig {
    fn default() -> Self {
        Self {
            max_retries: 1,
            attempt_timeout_ms: 10_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GoalJob {
    pub goal: Goal,
    pub behavior: GoalAttemptBehavior,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitOutcome {
    Accepted,
    Duplicate,
}

#[derive(Debug, Clone)]
pub struct GoalRunResult {
    pub goal: Goal,
    pub attempts: u8,
    pub traces: Vec<TraceEvent>,
}

#[derive(Debug, Clone)]
pub struct CoreEvent {
    pub source: String,
    pub actor_id: String,
    pub text: String,
    pub dedupe_key: Option<String>,
}

impl CoreEvent {
    pub fn new(
        source: impl Into<String>,
        actor_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            source: source.into(),
            actor_id: actor_id.into(),
            text: text.into(),
            dedupe_key: None,
        }
    }

    pub fn with_dedupe_key(mut self, dedupe_key: Option<String>) -> Self {
        self.dedupe_key = dedupe_key.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        self
    }
}

#[derive(Debug, Clone)]
pub enum GoalIntent {
    ScanWorkspace,
    UpdateReadme,
    ReadPath(String),
    GenericRecon,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    ToolCall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepPermission {
    Read,
    Write,
    Exec,
    Net,
}

impl StepPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Exec => "exec",
            Self::Net => "net",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Step {
    pub id: String,
    pub kind: StepKind,
    pub permission: StepPermission,
    pub tool_name: String,
    pub input: Option<String>,
}

impl Step {
    pub fn new(
        id: impl Into<String>,
        permission: StepPermission,
        tool_name: impl Into<String>,
        input: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: StepKind::ToolCall,
            permission,
            tool_name: tool_name.into(),
            input,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlanCandidate {
    pub id: String,
    pub rationale: String,
    pub score: f32,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone)]
pub struct TaskPipelineConfig {
    pub candidate_count: usize,
}

impl Default for TaskPipelineConfig {
    fn default() -> Self {
        Self { candidate_count: 3 }
    }
}

#[derive(Debug, Clone)]
pub struct TaskPlan {
    pub intent: GoalIntent,
    pub candidates: Vec<PlanCandidate>,
    pub selected_index: usize,
    pub traces: Vec<TraceEvent>,
}

#[derive(Debug, Clone)]
pub struct StepResult {
    pub step_id: String,
    pub tool_name: String,
    pub status: String,
    pub output: String,
}

#[derive(Debug, Clone)]
pub struct PendingApprovalAction {
    pub tool_name: String,
    pub capability: String,
    pub input: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskRunResult {
    pub goal: Goal,
    pub traces: Vec<TraceEvent>,
    pub plan: TaskPlan,
    pub step_results: Vec<StepResult>,
    pub pending_approval: Option<PendingApprovalAction>,
    pub reflection: String,
}

pub fn build_task_plan(goal_id: &str, event: &CoreEvent, config: &TaskPipelineConfig) -> TaskPlan {
    let intent = detect_intent(&event.text);
    let requested_candidates = config.candidate_count.clamp(2, 5);
    let mut candidates = match &intent {
        GoalIntent::ScanWorkspace => workspace_scan_candidates(),
        GoalIntent::UpdateReadme => update_readme_candidates(),
        GoalIntent::ReadPath(path) => read_intent_candidates(path),
        GoalIntent::GenericRecon => generic_recon_candidates(),
    };
    score_candidates(&mut candidates);
    candidates.truncate(requested_candidates);
    let selected_index = select_best_candidate_index(&candidates);
    let mut traces = Vec::new();
    traces.push(TraceEvent::new(
        goal_id.to_string(),
        "planning_started",
        format!(
            "Built {} plan candidates from event '{}'",
            candidates.len(),
            event.text.trim()
        ),
    ));
    for candidate in &candidates {
        traces.push(TraceEvent::new(
            goal_id.to_string(),
            "plan_candidate_generated",
            format!(
                "{} | score={:.2} | {}",
                candidate.id, candidate.score, candidate.rationale
            ),
        ));
    }
    traces.push(TraceEvent::new(
        goal_id.to_string(),
        "plan_selected",
        format!(
            "{} | steps={}",
            candidates[selected_index].id,
            candidates[selected_index].steps.len()
        ),
    ));
    traces.push(TraceEvent::new(
        goal_id.to_string(),
        "planning_completed",
        "Planner selected a candidate for execution",
    ));

    TaskPlan {
        intent,
        candidates,
        selected_index,
        traces,
    }
}

pub fn execute_task_plan_with_broker<FCap, FReq, FExec>(
    goal: Goal,
    plan: TaskPlan,
    permission_for_tool: FCap,
    requires_approval: FReq,
    mut execute_tool: FExec,
) -> TaskRunResult
where
    FCap: Fn(&str) -> Option<StepPermission>,
    FReq: Fn(StepPermission) -> bool,
    FExec: FnMut(&Step) -> Result<StepResult, String>,
{
    let mut traces = plan.traces.clone();
    let mut step_results = Vec::new();
    let mut pending_approval = None;
    let mut outcome_goal = goal;
    let selected = &plan.candidates[plan.selected_index];

    traces.push(TraceEvent::new(
        outcome_goal.id.clone(),
        "execution_started",
        format!("Executing selected plan {}", selected.id),
    ));

    for step in &selected.steps {
        let permission = permission_for_tool(&step.tool_name).unwrap_or(step.permission);
        if requires_approval(permission) {
            pending_approval = Some(PendingApprovalAction {
                tool_name: step.tool_name.clone(),
                capability: permission.as_str().to_string(),
                input: step.input.clone(),
            });
            traces.push(TraceEvent::new(
                outcome_goal.id.clone(),
                "approval_required",
                format!(
                    "{} requires {} approval",
                    step.tool_name,
                    permission.as_str()
                ),
            ));
            outcome_goal.status = GoalStatus::Pending;
            break;
        }

        match execute_tool(step) {
            Ok(result) => {
                traces.push(TraceEvent::new(
                    outcome_goal.id.clone(),
                    "tool_executed",
                    format!("{}:{} -> {}", step.id, result.tool_name, result.status),
                ));
                step_results.push(result);
            }
            Err(err) => {
                outcome_goal.status = GoalStatus::Failed;
                traces.push(TraceEvent::new(
                    outcome_goal.id.clone(),
                    "execution_failed",
                    format!("{}: {}", step.tool_name, err),
                ));
                let reflection = "Execution failed and was recorded for retry planning".to_string();
                traces.push(TraceEvent::new(
                    outcome_goal.id.clone(),
                    "reflection_recorded",
                    reflection.clone(),
                ));
                return TaskRunResult {
                    goal: outcome_goal,
                    traces,
                    plan,
                    step_results,
                    pending_approval,
                    reflection,
                };
            }
        }
    }

    if pending_approval.is_none() && !matches!(outcome_goal.status, GoalStatus::Failed) {
        outcome_goal.status = GoalStatus::Completed;
        traces.push(TraceEvent::new(
            outcome_goal.id.clone(),
            "execution_completed",
            format!("{} steps executed", step_results.len()),
        ));
    }

    let reflection = if pending_approval.is_some() {
        "Execution paused awaiting operator approval".to_string()
    } else {
        "Execution outcome recorded for future planning".to_string()
    };
    traces.push(TraceEvent::new(
        outcome_goal.id.clone(),
        "reflection_recorded",
        reflection.clone(),
    ));

    TaskRunResult {
        goal: outcome_goal,
        traces,
        plan,
        step_results,
        pending_approval,
        reflection,
    }
}

fn normalize_intent(text: &str) -> String {
    text.trim().to_ascii_lowercase()
}

fn detect_intent(text: &str) -> GoalIntent {
    let normalized = normalize_intent(text);
    if normalized.contains("scan workspace") {
        return GoalIntent::ScanWorkspace;
    }
    if normalized.contains("update readme") {
        return GoalIntent::UpdateReadme;
    }
    if let Some((_, path)) = normalized.split_once("read ") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return GoalIntent::ReadPath(trimmed.to_string());
        }
    }
    GoalIntent::GenericRecon
}

fn score_candidates(candidates: &mut [PlanCandidate]) {
    for candidate in candidates {
        let mut risk = 0.0_f32;
        let mut cost = candidate.steps.len() as f32 * 0.05;
        let mut confidence = 0.80_f32;
        for step in &candidate.steps {
            match step.permission {
                StepPermission::Read => {}
                StepPermission::Write => {
                    risk += 0.45;
                    confidence -= 0.10;
                }
                StepPermission::Exec => {
                    risk += 0.35;
                    confidence -= 0.08;
                }
                StepPermission::Net => {
                    risk += 0.30;
                    confidence -= 0.05;
                }
            }
            if step.input.is_none() {
                confidence -= 0.03;
            }
            if step.tool_name == "search_text" {
                cost += 0.03;
            }
        }
        candidate.score = (confidence - risk - cost).clamp(-1.0, 1.0);
    }
}

fn select_best_candidate_index(candidates: &[PlanCandidate]) -> usize {
    let mut best_idx = 0_usize;
    let mut best_score = f32::MIN;
    for (idx, candidate) in candidates.iter().enumerate() {
        if candidate.score > best_score {
            best_score = candidate.score;
            best_idx = idx;
        }
    }
    best_idx
}

fn workspace_scan_candidates() -> Vec<PlanCandidate> {
    vec![
        PlanCandidate {
            id: "cand_scan_read_1".to_string(),
            rationale: "Low-risk workspace scan with read-only tools".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "scan-1",
                    StepPermission::Read,
                    "list_dir",
                    Some(".".to_string()),
                ),
                Step::new(
                    "scan-2",
                    StepPermission::Read,
                    "search_text",
                    Some("TODO::.".to_string()),
                ),
                Step::new(
                    "scan-3",
                    StepPermission::Read,
                    "search_text",
                    Some("FIXME::.".to_string()),
                ),
            ],
        },
        PlanCandidate {
            id: "cand_scan_read_2".to_string(),
            rationale: "Prioritize source tree indexing before content sampling".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "scan-src-1",
                    StepPermission::Read,
                    "list_dir",
                    Some("src".to_string()),
                ),
                Step::new(
                    "scan-src-2",
                    StepPermission::Read,
                    "search_text",
                    Some("fn ::src".to_string()),
                ),
                Step::new(
                    "scan-src-3",
                    StepPermission::Read,
                    "search_text",
                    Some("mod ::src".to_string()),
                ),
            ],
        },
        PlanCandidate {
            id: "cand_scan_read_3".to_string(),
            rationale: "Wide read-only inspection for common config markers".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "scan-wide-1",
                    StepPermission::Read,
                    "list_dir",
                    Some(".".to_string()),
                ),
                Step::new(
                    "scan-wide-2",
                    StepPermission::Read,
                    "search_text",
                    Some("[workspace]::.".to_string()),
                ),
                Step::new(
                    "scan-wide-3",
                    StepPermission::Read,
                    "search_text",
                    Some("TODO::docs".to_string()),
                ),
            ],
        },
        PlanCandidate {
            id: "cand_scan_read_4".to_string(),
            rationale: "Focused read of README and docs metadata".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "scan-doc-1",
                    StepPermission::Read,
                    "read_file",
                    Some("README.md".to_string()),
                ),
                Step::new(
                    "scan-doc-2",
                    StepPermission::Read,
                    "search_text",
                    Some("Quickstart::docs".to_string()),
                ),
            ],
        },
        PlanCandidate {
            id: "cand_scan_read_5".to_string(),
            rationale: "Trace recent runtime context through memory artifacts".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "scan-trace-1",
                    StepPermission::Read,
                    "list_dir",
                    Some(".".to_string()),
                ),
                Step::new(
                    "scan-trace-2",
                    StepPermission::Read,
                    "search_text",
                    Some("trace::.".to_string()),
                ),
            ],
        },
    ]
}

fn update_readme_candidates() -> Vec<PlanCandidate> {
    vec![
        PlanCandidate {
            id: "cand_update_readme_1".to_string(),
            rationale: "Read current README then apply a deterministic append".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "readme-1",
                    StepPermission::Read,
                    "read_file",
                    Some("README.md".to_string()),
                ),
                Step::new(
                    "readme-2",
                    StepPermission::Write,
                    "write_file",
                    Some(
                        "README.md::\n## Install Steps (Generated)\n1. Run titan onboard\n2. Run titan run\n"
                            .to_string(),
                    ),
                ),
            ],
        },
        PlanCandidate {
            id: "cand_update_readme_2".to_string(),
            rationale: "Verify workspace then update README".to_string(),
            score: 0.0,
            steps: vec![
                Step::new("readme-alt-1", StepPermission::Read, "list_dir", Some(".".to_string())),
                Step::new(
                    "readme-alt-2",
                    StepPermission::Write,
                    "write_file",
                    Some(
                        "README.md::\n## Install Steps (Generated)\n1. Run titan onboard\n2. Run titan run\n"
                            .to_string(),
                    ),
                ),
            ],
        },
    ]
}

fn read_intent_candidates(path: &str) -> Vec<PlanCandidate> {
    let maybe_file = if path.trim().is_empty() {
        "README.md"
    } else {
        path.trim()
    };
    vec![
        PlanCandidate {
            id: "cand_read_1".to_string(),
            rationale: "Directly read requested file".to_string(),
            score: 0.0,
            steps: vec![Step::new(
                "read-1",
                StepPermission::Read,
                "read_file",
                Some(maybe_file.to_string()),
            )],
        },
        PlanCandidate {
            id: "cand_read_2".to_string(),
            rationale: "Validate path then read file".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "read-2",
                    StepPermission::Read,
                    "list_dir",
                    Some(".".to_string()),
                ),
                Step::new(
                    "read-3",
                    StepPermission::Read,
                    "read_file",
                    Some(maybe_file.to_string()),
                ),
            ],
        },
    ]
}

fn generic_recon_candidates() -> Vec<PlanCandidate> {
    vec![
        PlanCandidate {
            id: "cand_generic_1".to_string(),
            rationale: "Baseline read-only inspection".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "gen-1",
                    StepPermission::Read,
                    "list_dir",
                    Some(".".to_string()),
                ),
                Step::new(
                    "gen-2",
                    StepPermission::Read,
                    "search_text",
                    Some("TODO::.".to_string()),
                ),
            ],
        },
        PlanCandidate {
            id: "cand_generic_2".to_string(),
            rationale: "Inspect docs and project metadata".to_string(),
            score: 0.0,
            steps: vec![
                Step::new(
                    "gen-3",
                    StepPermission::Read,
                    "read_file",
                    Some("README.md".to_string()),
                ),
                Step::new(
                    "gen-4",
                    StepPermission::Read,
                    "search_text",
                    Some("titan::docs".to_string()),
                ),
            ],
        },
    ]
}

pub type RuntimeEvent = CoreEvent;
pub type Plan = TaskPlan;
pub type PlanStep = Step;
pub type StepExecution = StepResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct SubagentTask {
    pub id: String,
    pub parent_goal_id: String,
    pub description: String,
    pub depth: u8,
    pub status: SubagentStatus,
}

impl SubagentTask {
    pub fn new(
        parent_goal_id: impl Into<String>,
        description: impl Into<String>,
        depth: u8,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            parent_goal_id: parent_goal_id.into(),
            description: description.into(),
            depth,
            status: SubagentStatus::Pending,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SubagentConfig {
    pub max_depth: u8,
    pub max_parallel: usize,
}

impl Default for SubagentConfig {
    fn default() -> Self {
        Self {
            max_depth: 3,
            max_parallel: 8,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SubagentAggregateResult {
    pub completed: usize,
    pub failed: usize,
    pub traces: Vec<TraceEvent>,
}

#[derive(Debug)]
pub struct SubagentOrchestrator {
    config: SubagentConfig,
    tasks: Vec<SubagentTask>,
}

impl SubagentOrchestrator {
    pub fn new(config: SubagentConfig) -> Self {
        Self {
            config,
            tasks: Vec::new(),
        }
    }

    // Depth/parallel limits protect against runaway delegation loops.
    pub fn spawn(&mut self, task: SubagentTask) -> Result<(), String> {
        if task.depth > self.config.max_depth {
            return Err("subagent depth limit exceeded".to_string());
        }
        if self.tasks.len() >= self.config.max_parallel {
            return Err("subagent parallel limit exceeded".to_string());
        }
        self.tasks.push(task);
        Ok(())
    }

    pub fn list(&self) -> &[SubagentTask] {
        &self.tasks
    }

    pub fn run_all(&mut self) -> SubagentAggregateResult {
        let mut completed = 0_usize;
        let mut failed = 0_usize;
        let mut traces = Vec::new();

        for task in &mut self.tasks {
            task.status = SubagentStatus::Running;
            traces.push(TraceEvent::new(
                task.parent_goal_id.clone(),
                "subagent_started",
                format!("subagent {} started: {}", task.id, task.description),
            ));

            // Deterministic failure containment for this baseline:
            // descriptions containing "[fail]" simulate subagent failures.
            if task.description.to_lowercase().contains("[fail]") {
                task.status = SubagentStatus::Failed;
                failed += 1;
                traces.push(TraceEvent::new(
                    task.parent_goal_id.clone(),
                    "subagent_failed",
                    format!("subagent {} failed", task.id),
                ));
            } else {
                task.status = SubagentStatus::Completed;
                completed += 1;
                traces.push(TraceEvent::new(
                    task.parent_goal_id.clone(),
                    "subagent_completed",
                    format!("subagent {} completed", task.id),
                ));
            }
        }

        traces.push(TraceEvent::new(
            "aggregate",
            "subagent_aggregate",
            format!("completed={completed},failed={failed}"),
        ));

        SubagentAggregateResult {
            completed,
            failed,
            traces,
        }
    }
}

#[derive(Debug, Default)]
pub struct Runtime {
    state: RuntimeState,
    queue: VecDeque<GoalJob>,
    cancelled: HashSet<String>,
    seen_dedupe: HashSet<String>,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> RuntimeState {
        self.state
    }

    // Queue insertion is idempotent for dedupe_key to avoid duplicate jobs from repeated
    // inbound messages or retries from external gateways.
    pub fn submit(&mut self, job: GoalJob) -> SubmitOutcome {
        if let Some(dedupe_key) = &job.goal.dedupe_key {
            if self.seen_dedupe.contains(dedupe_key) {
                return SubmitOutcome::Duplicate;
            }
            self.seen_dedupe.insert(dedupe_key.clone());
        }
        self.queue.push_back(job);
        SubmitOutcome::Accepted
    }

    pub fn cancel(&mut self, goal_id: &str) {
        self.cancelled.insert(goal_id.to_string());
    }

    pub fn run_next(&mut self, config: GoalExecutionConfig) -> Option<GoalRunResult> {
        let mut job = self.queue.pop_front()?;
        self.state = RuntimeState::Running;

        let mut traces = vec![
            TraceEvent::new(
                job.goal.id.clone(),
                "planning_started",
                "Planner built execution strategy",
            ),
            TraceEvent::new(
                job.goal.id.clone(),
                "planning_completed",
                "Planner handed off to actor",
            ),
        ];

        if self.cancelled.contains(&job.goal.id) {
            job.goal.status = GoalStatus::Cancelled;
            traces.push(TraceEvent::new(
                job.goal.id.clone(),
                "goal_cancelled",
                "Goal cancelled before execution",
            ));
            traces.push(TraceEvent::new(
                job.goal.id.clone(),
                "reflection_recorded",
                "Execution skipped due to cancellation",
            ));
            self.state = if self.queue.is_empty() {
                RuntimeState::Idle
            } else {
                RuntimeState::Running
            };
            return Some(GoalRunResult {
                goal: job.goal,
                attempts: 0,
                traces,
            });
        }

        let mut attempts = 0_u8;
        let max_attempts = config.max_retries.saturating_add(1);

        while attempts < max_attempts {
            attempts = attempts.saturating_add(1);
            job.goal.status = GoalStatus::Executing;
            traces.push(TraceEvent::new(
                job.goal.id.clone(),
                "execution_started",
                format!("Attempt {attempts} started"),
            ));

            match job.behavior {
                GoalAttemptBehavior::Succeed => {
                    job.goal.status = GoalStatus::Completed;
                    traces.push(TraceEvent::new(
                        job.goal.id.clone(),
                        "execution_completed",
                        format!("Attempt {attempts} completed"),
                    ));
                    traces.push(TraceEvent::new(
                        job.goal.id.clone(),
                        "observation_recorded",
                        "Output validated",
                    ));
                    traces.push(TraceEvent::new(
                        job.goal.id.clone(),
                        "reflection_recorded",
                        "Successful strategy retained",
                    ));
                    break;
                }
                GoalAttemptBehavior::Fail => {
                    traces.push(TraceEvent::new(
                        job.goal.id.clone(),
                        "execution_failed",
                        format!("Attempt {attempts} failed"),
                    ));
                }
                GoalAttemptBehavior::Timeout => {
                    traces.push(TraceEvent::new(
                        job.goal.id.clone(),
                        "execution_timeout",
                        format!(
                            "Attempt {attempts} exceeded timeout {}ms",
                            config.attempt_timeout_ms
                        ),
                    ));
                }
            }

            if attempts < max_attempts {
                traces.push(TraceEvent::new(
                    job.goal.id.clone(),
                    "retry_scheduled",
                    format!("Scheduling retry {}", attempts.saturating_add(1)),
                ));
            } else {
                job.goal.status = GoalStatus::Failed;
                traces.push(TraceEvent::new(
                    job.goal.id.clone(),
                    "observation_recorded",
                    "Failure observed after final attempt",
                ));
                traces.push(TraceEvent::new(
                    job.goal.id.clone(),
                    "reflection_recorded",
                    "Marked for future strategy refinement",
                ));
            }
        }

        self.state = if self.queue.is_empty() {
            RuntimeState::Idle
        } else {
            RuntimeState::Running
        };

        Some(GoalRunResult {
            goal: job.goal,
            attempts,
            traces,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_job(behavior: GoalAttemptBehavior, dedupe_key: Option<&str>) -> GoalJob {
        GoalJob {
            goal: Goal::new("test goal").with_dedupe_key(dedupe_key.map(str::to_string)),
            behavior,
        }
    }

    #[test]
    fn submit_is_idempotent_for_dedupe_key() {
        let mut runtime = Runtime::new();
        let first = runtime.submit(test_job(GoalAttemptBehavior::Succeed, Some("same-key")));
        let second = runtime.submit(test_job(GoalAttemptBehavior::Succeed, Some("same-key")));
        assert_eq!(first, SubmitOutcome::Accepted);
        assert_eq!(second, SubmitOutcome::Duplicate);
    }

    #[test]
    fn retries_then_fails_after_max_attempts() {
        let mut runtime = Runtime::new();
        assert_eq!(
            runtime.submit(test_job(GoalAttemptBehavior::Fail, None)),
            SubmitOutcome::Accepted
        );
        let result = runtime
            .run_next(GoalExecutionConfig {
                max_retries: 2,
                attempt_timeout_ms: 1_000,
            })
            .expect("job should run");
        assert_eq!(result.goal.status, GoalStatus::Failed);
        assert_eq!(result.attempts, 3);
        assert!(
            result
                .traces
                .iter()
                .any(|t| t.event_type == "retry_scheduled")
        );
    }

    #[test]
    fn timeout_path_records_timeout_event() {
        let mut runtime = Runtime::new();
        runtime.submit(test_job(GoalAttemptBehavior::Timeout, None));
        let result = runtime.run_next(GoalExecutionConfig::default()).unwrap();
        assert_eq!(result.goal.status, GoalStatus::Failed);
        assert!(
            result
                .traces
                .iter()
                .any(|t| t.event_type == "execution_timeout")
        );
    }

    #[test]
    fn cancellation_marks_goal_cancelled() {
        let mut runtime = Runtime::new();
        let job = test_job(GoalAttemptBehavior::Succeed, None);
        let goal_id = job.goal.id.clone();
        runtime.submit(job);
        runtime.cancel(&goal_id);
        let result = runtime.run_next(GoalExecutionConfig::default()).unwrap();
        assert_eq!(result.goal.status, GoalStatus::Cancelled);
        assert_eq!(result.attempts, 0);
        assert!(
            result
                .traces
                .iter()
                .any(|t| t.event_type == "goal_cancelled")
        );
    }

    #[test]
    fn subagent_depth_limit_enforced() {
        let mut orchestrator = SubagentOrchestrator::new(SubagentConfig {
            max_depth: 2,
            max_parallel: 4,
        });
        let parent = Goal::new("parent");
        let too_deep = SubagentTask::new(parent.id, "deep task", 3);
        let err = orchestrator
            .spawn(too_deep)
            .expect_err("should reject depth");
        assert!(err.contains("depth limit"));
    }

    #[test]
    fn subagent_failure_contained_with_aggregate_result() {
        let mut orchestrator = SubagentOrchestrator::new(SubagentConfig::default());
        let parent = Goal::new("parent");
        orchestrator
            .spawn(SubagentTask::new(parent.id.clone(), "task A", 1))
            .unwrap();
        orchestrator
            .spawn(SubagentTask::new(parent.id.clone(), "task B [fail]", 1))
            .unwrap();

        let result = orchestrator.run_all();
        assert_eq!(result.completed, 1);
        assert_eq!(result.failed, 1);
        assert!(
            result
                .traces
                .iter()
                .any(|t| t.event_type == "subagent_aggregate")
        );
    }

    #[test]
    fn planner_generates_two_to_five_candidates() {
        let goal = Goal::new("scan");
        let event = CoreEvent::new("discord", "user-1", "scan workspace");
        let plan = build_task_plan(&goal.id, &event, &TaskPipelineConfig { candidate_count: 5 });
        assert!(plan.candidates.len() >= 2);
        assert!(plan.candidates.len() <= 5);
        assert!(plan.selected_index < plan.candidates.len());
        assert!(
            plan.traces
                .iter()
                .any(|trace| trace.event_type == "plan_selected")
        );
    }

    #[test]
    fn execution_pauses_when_step_requires_approval() {
        let goal = Goal::new("write request");
        let event = CoreEvent::new("discord", "user-1", "update README with install steps");
        let plan = build_task_plan(&goal.id, &event, &TaskPipelineConfig { candidate_count: 2 });

        let result = execute_task_plan_with_broker(
            goal,
            plan,
            |tool| {
                if tool == "write_file" {
                    Some(StepPermission::Write)
                } else {
                    Some(StepPermission::Read)
                }
            },
            |capability| capability == StepPermission::Write,
            |step| {
                Ok(StepResult {
                    step_id: step.id.clone(),
                    tool_name: step.tool_name.to_string(),
                    status: "success".to_string(),
                    output: "ok".to_string(),
                })
            },
        );

        assert!(result.pending_approval.is_some());
        assert!(
            result
                .traces
                .iter()
                .any(|trace| trace.event_type == "approval_required")
        );
    }
}
