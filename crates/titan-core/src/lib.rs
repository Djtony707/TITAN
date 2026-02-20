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
}
