use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use titan_common::AutonomyMode;
use titan_gateway::{Channel as GatewayChannel, InboundEvent, TitanGatewayRuntime};
use titan_memory::MemoryStore;
use titan_tools::{ToolExecutionContext, ToolExecutor, ToolRegistry};

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    workspace_root: PathBuf,
    mode: String,
}

#[derive(Debug, Serialize)]
struct ApiHealth {
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct GoalDto {
    id: String,
    description: String,
    status: String,
    dedupe_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct ApprovalDto {
    id: String,
    tool_name: String,
    capability: String,
    status: String,
    requested_by: Option<String>,
    expires_at_ms: i64,
}

#[derive(Debug, Serialize)]
struct TraceDto {
    goal_id: String,
    event_type: String,
    detail: String,
}

#[derive(Debug, Serialize)]
struct EpisodicMemoryDto {
    id: i64,
    goal_id: String,
    summary: String,
    source: String,
}

#[derive(Debug, Serialize)]
struct RuntimeStatusDto {
    mode: String,
    queue_depth: usize,
    pending_approvals: usize,
}

#[derive(Debug, Serialize)]
struct SkillDto {
    slug: String,
    name: String,
    version: String,
    signature_status: String,
    scopes: String,
    last_run_goal_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    pattern: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct DecisionInput {
    reason: Option<String>,
    resolved_by: Option<String>,
}

#[derive(Debug, Serialize)]
struct DecisionOutput {
    status: String,
    detail: String,
}

#[derive(Debug, Deserialize)]
struct ChatInput {
    actor_id: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct ChatOutput {
    response: String,
    session_id: String,
}

pub async fn serve(
    bind_addr: &str,
    db_path: PathBuf,
    workspace_root: PathBuf,
    mode: String,
) -> Result<()> {
    let state = Arc::new(AppState {
        db_path,
        workspace_root,
        mode,
    });
    let app = Router::new()
        .route("/", get(index))
        .route("/api/health", get(api_health))
        .route("/api/runtime/status", get(api_runtime_status))
        .route("/api/goals", get(api_goals))
        .route("/api/approvals/pending", get(api_pending_approvals))
        .route("/api/chat", post(api_chat))
        .route("/api/memory/episodic", get(api_episodic_memory))
        .route("/api/traces/recent", get(api_recent_traces))
        .route("/api/traces/search", get(api_search_traces))
        .route("/api/skills", get(api_skills))
        .route("/api/approvals/{id}/approve", post(api_approve))
        .route("/api/approvals/{id}/deny", post(api_deny))
        .with_state(state);

    let addr: SocketAddr = bind_addr
        .parse()
        .with_context(|| format!("invalid bind address: {bind_addr}"))?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn index() -> impl IntoResponse {
    Html(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>TITAN Dashboard</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #f7f9fc; color: #14213d; }
    h1 { margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card { background: white; border: 1px solid #dfe7f3; border-radius: 10px; padding: 12px; }
    button { margin-right: 8px; }
    pre { white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>TITAN Web Dashboard</h1>
  <p>Mode, approvals, goals, traces, and episodic memory.</p>
  <div class="grid">
    <div class="card"><h3>Runtime</h3><pre id="runtime"></pre></div>
    <div class="card"><h3>Pending Approvals</h3><div id="approvals"></div></div>
    <div class="card"><h3>Goals</h3><div id="goals"></div></div>
    <div class="card"><h3>Recent Traces</h3><pre id="recent_traces"></pre></div>
    <div class="card"><h3>Episodic Memory</h3><pre id="memory"></pre></div>
    <div class="card"><h3>Skills</h3><pre id="skills"></pre></div>
    <div class="card"><h3>Webchat</h3>
      <input id="chat_actor" value="web-user" />
      <input id="chat_message" value="/status" />
      <button onclick="sendChat()">Send</button>
      <pre id="chat_output"></pre>
    </div>
    <div class="card"><h3>Trace Search</h3>
      <input id="pattern" value="execution" />
      <button onclick="loadTraces()">Search</button>
      <pre id="traces"></pre>
    </div>
  </div>
  <script>
    async function loadRuntime() {
      const res = await fetch('/api/runtime/status');
      const row = await res.json();
      document.getElementById('runtime').textContent =
        `mode=${row.mode}\nqueue_depth=${row.queue_depth}\npending_approvals=${row.pending_approvals}`;
    }
    async function loadApprovals() {
      const res = await fetch('/api/approvals/pending');
      const rows = await res.json();
      const el = document.getElementById('approvals');
      if (!rows.length) { el.innerText = 'No pending approvals'; return; }
      el.innerHTML = rows.map(a => `
        <div>
          <b>${a.tool_name}</b> (${a.capability}) [${a.id}]<br/>
          <button onclick="approve('${a.id}')">Approve</button>
          <button onclick="deny('${a.id}')">Deny</button>
        </div><hr/>`).join('');
    }
    async function loadGoals() {
      const res = await fetch('/api/goals?limit=20');
      const rows = await res.json();
      document.getElementById('goals').innerHTML = rows.map(g => `<div><b>${g.status}</b> ${g.id}<br/>${g.description}</div><hr/>`).join('');
    }
    async function loadTraces() {
      const pattern = document.getElementById('pattern').value;
      const res = await fetch('/api/traces/search?pattern=' + encodeURIComponent(pattern) + '&limit=20');
      const rows = await res.json();
      document.getElementById('traces').textContent = rows.map(t => `${t.goal_id} | ${t.event_type} | ${t.detail}`).join('\n');
    }
    async function loadRecentTraces() {
      const res = await fetch('/api/traces/recent?limit=20');
      const rows = await res.json();
      document.getElementById('recent_traces').textContent =
        rows.map(t => `${t.goal_id} | ${t.event_type} | ${t.detail}`).join('\n');
    }
    async function loadMemory() {
      const res = await fetch('/api/memory/episodic?limit=20');
      const rows = await res.json();
      document.getElementById('memory').textContent =
        rows.map(m => `#${m.id} | ${m.goal_id} | ${m.source}\n${m.summary}`).join('\n\n');
    }
    async function loadSkills() {
      const res = await fetch('/api/skills');
      const rows = await res.json();
      document.getElementById('skills').textContent =
        rows.map(s => `${s.slug}@${s.version} | signed=${s.signature_status} | scopes=${s.scopes} | last_run=${s.last_run_goal_id || '<none>'}`).join('\n');
    }
    async function approve(id) {
      await fetch('/api/approvals/' + id + '/approve', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({resolved_by:'web'}) });
      await loadApprovals(); await loadGoals(); await loadRecentTraces(); await loadMemory(); await loadSkills();
    }
    async function sendChat() {
      const actor = document.getElementById('chat_actor').value || 'web-user';
      const message = document.getElementById('chat_message').value;
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({actor_id: actor, message})
      });
      const body = await res.json();
      document.getElementById('chat_output').textContent =
        `session=${body.session_id}\n${body.response}`;
      await loadRuntime(); await loadGoals(); await loadRecentTraces(); await loadMemory(); await loadApprovals(); await loadSkills();
    }
    async function deny(id) {
      await fetch('/api/approvals/' + id + '/deny', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({resolved_by:'web'}) });
      await loadApprovals();
    }
    loadRuntime(); loadApprovals(); loadGoals(); loadTraces(); loadRecentTraces(); loadMemory(); loadSkills();
    setInterval(loadRuntime, 3000);
    setInterval(loadApprovals, 3000);
    setInterval(loadRecentTraces, 3000);
    setInterval(loadMemory, 5000);
    setInterval(loadSkills, 5000);
  </script>
</body>
</html>"#,
    )
}

async fn api_health() -> Json<ApiHealth> {
    Json(ApiHealth { status: "ok" })
}

async fn api_goals(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<GoalDto>>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let limit = query.limit.unwrap_or(20).min(200);
    let goals = store
        .list_goals(limit)
        .map_err(internal_error)?
        .into_iter()
        .map(|g| GoalDto {
            id: g.id,
            description: g.description,
            status: g.status,
            dedupe_key: g.dedupe_key,
        })
        .collect();
    Ok(Json(goals))
}

async fn api_runtime_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RuntimeStatusDto>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let queue_depth = store.count_active_goals().map_err(internal_error)?;
    let pending_approvals = store
        .list_pending_approvals()
        .map_err(internal_error)?
        .len();
    Ok(Json(RuntimeStatusDto {
        mode: state.mode.clone(),
        queue_depth,
        pending_approvals,
    }))
}

async fn api_chat(
    State(state): State<Arc<AppState>>,
    Json(input): Json<ChatInput>,
) -> Result<Json<ChatOutput>, (StatusCode, String)> {
    if input.actor_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "actor_id is required".to_string()));
    }
    if input.message.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "message is required".to_string()));
    }
    let runtime = TitanGatewayRuntime::new(
        parse_mode(&state.mode),
        state.workspace_root.clone(),
        state.db_path.clone(),
    );
    let output = runtime
        .process_chat_input(InboundEvent::new(
            GatewayChannel::Webchat,
            input.actor_id.trim(),
            input.message.trim(),
        ))
        .map_err(internal_error)?;
    Ok(Json(ChatOutput {
        response: output.response,
        session_id: output.session_id,
    }))
}

async fn api_pending_approvals(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ApprovalDto>>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let approvals = store
        .list_pending_approvals()
        .map_err(internal_error)?
        .into_iter()
        .map(|a| ApprovalDto {
            id: a.id,
            tool_name: a.tool_name,
            capability: a.capability,
            status: a.status,
            requested_by: a.requested_by,
            expires_at_ms: a.expires_at_ms,
        })
        .collect();
    Ok(Json(approvals))
}

async fn api_search_traces(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<TraceDto>>, (StatusCode, String)> {
    if query.pattern.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "pattern is required".to_string()));
    }
    let store = open_store(&state)?;
    let limit = query.limit.unwrap_or(20).min(200);
    let traces = store
        .search_traces(&query.pattern, limit)
        .map_err(internal_error)?
        .into_iter()
        .map(|t| TraceDto {
            goal_id: t.goal_id,
            event_type: t.event_type,
            detail: t.detail,
        })
        .collect();
    Ok(Json(traces))
}

async fn api_recent_traces(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<TraceDto>>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let limit = query.limit.unwrap_or(20).min(200);
    let traces = store
        .list_recent_traces(limit)
        .map_err(internal_error)?
        .into_iter()
        .map(|t| TraceDto {
            goal_id: t.goal_id,
            event_type: t.event_type,
            detail: t.detail,
        })
        .collect();
    Ok(Json(traces))
}

async fn api_skills(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SkillDto>>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let skills = store
        .list_installed_skills()
        .map_err(internal_error)?
        .into_iter()
        .map(|row| SkillDto {
            slug: row.slug,
            name: row.name,
            version: row.version,
            signature_status: row.signature_status,
            scopes: row.scopes,
            last_run_goal_id: row.last_run_goal_id,
        })
        .collect::<Vec<_>>();
    Ok(Json(skills))
}

async fn api_episodic_memory(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<EpisodicMemoryDto>>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let limit = query.limit.unwrap_or(20).min(200);
    let rows = store
        .list_episodic_memory(limit)
        .map_err(internal_error)?
        .into_iter()
        .map(|row| EpisodicMemoryDto {
            id: row.id,
            goal_id: row.goal_id,
            summary: row.summary,
            source: row.source,
        })
        .collect();
    Ok(Json(rows))
}

async fn api_approve(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<DecisionOutput>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let approval = store
        .get_approval_request(&id)
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "approval not found".to_string()))?;

    if store.approval_has_tool_run(&id).map_err(internal_error)? {
        return Ok(Json(DecisionOutput {
            status: "replay_blocked".to_string(),
            detail: id,
        }));
    }

    let resolved = store
        .resolve_approval_request(
            &id,
            true,
            input.resolved_by.as_deref().or(Some("web")),
            input.reason.as_deref(),
        )
        .map_err(internal_error)?;
    if !resolved {
        return Ok(Json(DecisionOutput {
            status: "not_pending".to_string(),
            detail: id,
        }));
    }

    if approval.tool_name == "skill_install" {
        let payload =
            titan_skills::deserialize_approval_payload(&approval.input).map_err(internal_error)?;
        let installed =
            titan_skills::finalize_install_from_payload(&payload).map_err(internal_error)?;
        store
            .upsert_installed_skill(&titan_memory::InstalledSkillRecord {
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
            })
            .map_err(internal_error)?;
        return Ok(Json(DecisionOutput {
            status: "approved".to_string(),
            detail: "skill_install_finalized".to_string(),
        }));
    }

    if approval.tool_name == "skill_exec_grant" {
        return Ok(Json(DecisionOutput {
            status: "approved".to_string(),
            detail: "skill_exec_grant".to_string(),
        }));
    }

    let registry = ToolRegistry::with_defaults();
    let Some(tool) = registry.get(&approval.tool_name) else {
        return Ok(Json(DecisionOutput {
            status: "approved_no_tool".to_string(),
            detail: approval.tool_name,
        }));
    };

    let exec_ctx = ToolExecutionContext::default_for_workspace(state.workspace_root.clone());
    let input_ref = if approval.input.trim().is_empty() {
        None
    } else {
        Some(approval.input.as_str())
    };
    let result = ToolExecutor::execute(tool, input_ref, &exec_ctx).map_err(internal_error)?;
    store
        .record_tool_run(Some(&id), &tool.name, &result.status, &result.output)
        .map_err(internal_error)?;

    Ok(Json(DecisionOutput {
        status: "approved".to_string(),
        detail: result.status,
    }))
}

async fn api_deny(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<DecisionOutput>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let resolved = store
        .resolve_approval_request(
            &id,
            false,
            input.resolved_by.as_deref().or(Some("web")),
            input.reason.as_deref(),
        )
        .map_err(internal_error)?;
    if !resolved {
        return Ok(Json(DecisionOutput {
            status: "not_pending".to_string(),
            detail: id,
        }));
    }
    Ok(Json(DecisionOutput {
        status: "denied".to_string(),
        detail: id,
    }))
}

fn open_store(state: &AppState) -> Result<MemoryStore, (StatusCode, String)> {
    MemoryStore::open(&state.db_path).map_err(internal_error)
}

fn internal_error(err: impl std::fmt::Display) -> (StatusCode, String) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("internal error: {}", err),
    )
}

fn parse_mode(value: &str) -> AutonomyMode {
    match value.trim().to_ascii_lowercase().as_str() {
        "supervised" => AutonomyMode::Supervised,
        "autonomous" => AutonomyMode::Autonomous,
        _ => AutonomyMode::Collaborative,
    }
}

pub fn default_bind_addr() -> &'static str {
    "127.0.0.1:3000"
}
