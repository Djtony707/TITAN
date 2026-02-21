use std::collections::BTreeMap;

use httpmock::Method::{GET, POST};
use httpmock::MockServer;
use serde_json::json;
use tempfile::tempdir;
use titan_common::AutonomyMode;
use titan_connectors::{
    InMemorySecretResolver, SecretResolver, execute_connector_tool_after_approval,
    execute_connector_tool_mediated,
};
use titan_memory::{MemoryStore, RiskMode};
use titan_secrets::SecretsStore;
use uuid::Uuid;

struct StoreBackedSecretResolver {
    store: SecretsStore,
}

impl titan_connectors::SecretResolver for StoreBackedSecretResolver {
    fn get_secret(&self, key_id: &str) -> anyhow::Result<Option<String>> {
        self.store.get_secret(key_id)
    }
}

fn setup_store() -> (tempfile::TempDir, MemoryStore) {
    let tmp = tempdir().expect("tempdir");
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace dir");
    let db_path = workspace.join("titan.db");
    let store = MemoryStore::open(&db_path).expect("open store");
    (tmp, store)
}

fn add_github_connector(store: &MemoryStore, base_url: &str) -> String {
    let id = Uuid::new_v4().to_string();
    let config = json!({
        "owner": "acme",
        "repo": "titan",
        "base_url": base_url,
    });
    store
        .add_connector(&id, "github", "GitHub", &config.to_string())
        .expect("add connector");
    id
}

#[test]
fn connector_read_is_traced_and_policy_mediated() {
    let server = MockServer::start();
    let _issues = server.mock(|when, then| {
        when.method(GET)
            .path("/repos/acme/titan/issues")
            .query_param("per_page", "20")
            .header("authorization", "Bearer fake-token")
            .header("user-agent", "titan-connectors");
        then.status(200)
            .header("content-type", "application/json")
            .body("[]");
    });

    let (_tmp, store) = setup_store();
    let connector_id = add_github_connector(&store, &server.base_url());
    let mut secrets = BTreeMap::new();
    secrets.insert(
        format!("connector:{connector_id}:github_token"),
        "fake-token".to_string(),
    );
    let resolver = InMemorySecretResolver::new(secrets);

    let outcome = execute_connector_tool_mediated(
        &store,
        AutonomyMode::Autonomous,
        "test",
        &connector_id,
        "github.list_issues",
        json!({}),
        &resolver,
    )
    .expect("execute read connector tool");

    assert!(outcome.executed);
    assert!(outcome.approval_id.is_none());

    let traces = store.get_traces(&outcome.goal_id).expect("list traces");
    assert!(
        traces
            .iter()
            .any(|trace| trace.event_type == "connector_tool_requested")
    );
    assert!(
        traces
            .iter()
            .any(|trace| trace.event_type == "connector_tool_result" && trace.risk_mode == "secure")
    );
}

#[test]
fn connector_write_requires_approval_in_secure_collab() {
    let server = MockServer::start();
    let create_issue = server.mock(|when, then| {
        when.method(POST).path("/repos/acme/titan/issues");
        then.status(201)
            .header("content-type", "application/json")
            .body(r#"{"id": 42, "title": "x"}"#);
    });

    let (_tmp, store) = setup_store();
    let connector_id = add_github_connector(&store, &server.base_url());
    let mut secrets = BTreeMap::new();
    secrets.insert(
        format!("connector:{connector_id}:github_token"),
        "fake-token".to_string(),
    );
    let resolver = InMemorySecretResolver::new(secrets);

    let outcome = execute_connector_tool_mediated(
        &store,
        AutonomyMode::Collaborative,
        "test",
        &connector_id,
        "github.create_issue",
        json!({"title": "hello", "body": "world"}),
        &resolver,
    )
    .expect("queue write approval");

    assert!(!outcome.executed);
    assert!(outcome.approval_id.is_some());
    assert_eq!(create_issue.hits(), 0);
}

#[test]
fn connector_write_executes_in_yolo_without_approval() {
    let server = MockServer::start();
    let create_issue = server.mock(|when, then| {
        when.method(POST)
            .path("/repos/acme/titan/issues")
            .header("authorization", "Bearer fake-token");
        then.status(201)
            .header("content-type", "application/json")
            .body(r#"{"id": 77, "title": "demo"}"#);
    });

    let (_tmp, store) = setup_store();
    store.arm_yolo("test").expect("arm yolo");
    store.enable_yolo("test", 5).expect("enable yolo");
    assert!(matches!(
        store
            .get_runtime_risk_state()
            .expect("risk state")
            .risk_mode,
        RiskMode::Yolo
    ));

    let connector_id = add_github_connector(&store, &server.base_url());
    let mut secrets = BTreeMap::new();
    secrets.insert(
        format!("connector:{connector_id}:github_token"),
        "fake-token".to_string(),
    );
    let resolver = InMemorySecretResolver::new(secrets);

    let outcome = execute_connector_tool_mediated(
        &store,
        AutonomyMode::Collaborative,
        "test",
        &connector_id,
        "github.create_issue",
        json!({"title": "demo", "body": "body"}),
        &resolver,
    )
    .expect("execute yolo write");

    assert!(outcome.executed);
    assert!(outcome.approval_id.is_none());
    assert_eq!(create_issue.hits(), 1);
    let traces = store.get_traces(&outcome.goal_id).expect("list traces");
    assert!(traces.iter().any(|trace| trace.risk_mode == "yolo"));
}

#[test]
fn secrets_never_persist_plaintext() {
    let (tmp, store) = setup_store();
    let connector_id = add_github_connector(&store, "https://api.github.com");
    let token = "plain-text-token-never-in-db";

    let mut secrets = SecretsStore::at_path(tmp.path().join("secrets.enc"));
    secrets.unlock("test-passphrase").expect("unlock secrets");
    secrets
        .set_secret(&format!("connector:{connector_id}:github_token"), token)
        .expect("set secret");

    let resolver = StoreBackedSecretResolver { store: secrets };

    let read = resolver
        .get_secret(&format!("connector:{connector_id}:github_token"))
        .expect("get secret");
    assert_eq!(read.as_deref(), Some(token));

    let db_dump = std::fs::read(tmp.path().join("workspace/titan.db")).expect("db bytes");
    let db_text = String::from_utf8_lossy(&db_dump);
    assert!(!db_text.contains(token));
}

#[test]
fn connector_write_can_be_finalized_after_approval() {
    let server = MockServer::start();
    let create_issue = server.mock(|when, then| {
        when.method(POST).path("/repos/acme/titan/issues");
        then.status(201)
            .header("content-type", "application/json")
            .body(r#"{"id": 100, "title": "approved"}"#);
    });

    let (_tmp, store) = setup_store();
    let connector_id = add_github_connector(&store, &server.base_url());
    let mut secrets = BTreeMap::new();
    secrets.insert(
        format!("connector:{connector_id}:github_token"),
        "fake-token".to_string(),
    );
    let resolver = InMemorySecretResolver::new(secrets);

    let queued = execute_connector_tool_mediated(
        &store,
        AutonomyMode::Collaborative,
        "tester",
        &connector_id,
        "github.create_issue",
        json!({"title":"approve-me", "body":"please"}),
        &resolver,
    )
    .expect("queue approval");
    let approval_id = queued.approval_id.expect("approval id");
    let approval = store
        .get_approval_request(&approval_id)
        .expect("approval lookup")
        .expect("approval row");

    let final_outcome =
        execute_connector_tool_after_approval(&store, "tester", &approval.input, &resolver)
            .expect("finalize connector approval");

    assert!(final_outcome.executed);
    assert_eq!(create_issue.hits(), 1);
}
