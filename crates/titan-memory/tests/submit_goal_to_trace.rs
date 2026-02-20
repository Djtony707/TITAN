use tempfile::tempdir;
use titan_core::{Goal, GoalAttemptBehavior, GoalExecutionConfig, GoalJob, Runtime, SubmitOutcome};
use titan_memory::MemoryStore;

#[test]
fn submit_goal_to_trace_persists_full_lifecycle() {
    let tmp = tempdir().expect("tempdir should be created");
    let db_path = tmp.path().join("titan.db");
    let store = MemoryStore::open(&db_path).expect("memory store should open");

    let goal = Goal::new("integration lifecycle");
    store.create_goal(&goal).expect("goal should persist");
    store
        .add_trace_event(&titan_core::TraceEvent::new(
            goal.id.clone(),
            "goal_submitted",
            "integration lifecycle",
        ))
        .expect("submission trace should persist");

    let mut runtime = Runtime::new();
    let accepted = runtime.submit(GoalJob {
        goal: goal.clone(),
        behavior: GoalAttemptBehavior::Succeed,
    });
    assert_eq!(accepted, SubmitOutcome::Accepted);

    let result = runtime
        .run_next(GoalExecutionConfig {
            max_retries: 1,
            attempt_timeout_ms: 10_000,
        })
        .expect("queued goal should execute");

    for trace in &result.traces {
        store
            .add_trace_event(trace)
            .expect("runtime trace should persist");
    }
    store
        .update_goal_status(&result.goal.id, result.goal.status)
        .expect("final status should persist");

    let saved_goal = store
        .get_goal(&goal.id)
        .expect("goal lookup should work")
        .expect("goal should exist");
    assert_eq!(saved_goal.status, "completed");

    let traces = store
        .get_traces(&goal.id)
        .expect("trace lookup should work");
    assert!(traces.iter().any(|t| t.event_type == "goal_submitted"));
    assert!(traces.iter().any(|t| t.event_type == "planning_started"));
    assert!(traces.iter().any(|t| t.event_type == "execution_started"));
    assert!(
        traces
            .iter()
            .any(|t| t.event_type == "observation_recorded")
    );
    assert!(traces.iter().any(|t| t.event_type == "reflection_recorded"));
}
