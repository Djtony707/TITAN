use tempfile::tempdir;
use titan_memory::MemoryStore;

#[test]
fn approval_expires_after_ttl_window() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("titan.db");
    let store = MemoryStore::open(&db).expect("open store");

    let approval = store
        .create_approval_request("run_command", "exec", "echo hi", Some("test"), 1)
        .expect("create approval");

    std::thread::sleep(std::time::Duration::from_millis(5));
    store
        .expire_pending_approvals(i64::MAX)
        .expect("expire pending");
    let row = store
        .get_approval_request(&approval.id)
        .expect("lookup approval")
        .expect("approval exists");
    assert_eq!(row.status, "expired");
}

#[test]
fn tool_run_marks_approval_as_non_replayable() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("titan.db");
    let store = MemoryStore::open(&db).expect("open store");

    let approval = store
        .create_approval_request("run_command", "exec", "echo hi", Some("test"), 60_000)
        .expect("create approval");
    assert!(
        !store
            .approval_has_tool_run(&approval.id)
            .expect("check pre-run")
    );

    store
        .record_tool_run(Some(&approval.id), "run_command", "success", "ok")
        .expect("record run");

    assert!(
        store
            .approval_has_tool_run(&approval.id)
            .expect("check post-run")
    );
}
