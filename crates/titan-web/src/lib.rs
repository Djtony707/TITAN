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
use titan_comms::{ChannelKind, channel_status};
use titan_connectors::{
    CompositeSecretResolver, execute_connector_tool_after_approval, test_connector,
};
use titan_gateway::{Channel as GatewayChannel, InboundEvent, TitanGatewayRuntime};
use titan_memory::MemoryStore;
use titan_tools::{ToolExecutionContext, ToolExecutor, ToolRegistry};

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    workspace_root: PathBuf,
    mode: String,
    yolo_bypass_path_guard: bool,
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
    risk_mode: String,
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
    risk_mode: String,
    yolo_expires_at_ms: Option<i64>,
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

#[derive(Debug, Serialize)]
struct ChannelStatusDto {
    channel: String,
    configured: bool,
    status: String,
    detail: String,
}

#[derive(Debug, Serialize)]
struct SessionDto {
    id: String,
    channel: String,
    peer_id: String,
    queue_depth: i64,
    compactions_count: i64,
}

#[derive(Debug, Serialize)]
struct MissionControlDto {
    mode: String,
    risk_mode: String,
    yolo_expires_at_ms: Option<i64>,
    channels: Vec<ChannelStatusDto>,
    sessions: Vec<SessionDto>,
    pending_approvals: Vec<ApprovalDto>,
    connectors: Vec<ConnectorDto>,
    connector_summary: ConnectorSummaryDto,
    skills: Vec<SkillDto>,
    recent_runs: Vec<GoalDto>,
    recent_traces: Vec<TraceDto>,
}

#[derive(Debug, Serialize)]
struct ConnectorDto {
    id: String,
    connector_type: String,
    display_name: String,
    last_test_at_ms: Option<i64>,
    last_test_status: Option<String>,
}

#[derive(Debug, Serialize)]
struct ConnectorSummaryDto {
    total: usize,
    failing: usize,
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
    yolo_bypass_path_guard: bool,
) -> Result<()> {
    let state = Arc::new(AppState {
        db_path,
        workspace_root,
        mode,
        yolo_bypass_path_guard,
    });
    let app = app_router(state);

    let addr: SocketAddr = bind_addr
        .parse()
        .with_context(|| format!("invalid bind address: {bind_addr}"))?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn app_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/mission-control", get(mission_control_page))
        .route("/api/health", get(api_health))
        .route("/api/runtime/status", get(api_runtime_status))
        .route("/api/goals", get(api_goals))
        .route("/api/approvals/pending", get(api_pending_approvals))
        .route("/api/chat", post(api_chat))
        .route("/api/memory/episodic", get(api_episodic_memory))
        .route("/api/traces/recent", get(api_recent_traces))
        .route("/api/traces/search", get(api_search_traces))
        .route("/api/skills", get(api_skills))
        .route("/api/connectors", get(api_connectors))
        .route("/api/connectors/{id}/test", post(api_connector_test))
        .route("/api/mission-control", get(api_mission_control))
        .route("/api/approvals/{id}/approve", post(api_approve))
        .route("/api/approvals/{id}/deny", post(api_deny))
        .with_state(state)
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
        `mode=${row.mode}\nrisk_mode=${row.risk_mode}\nyolo_expires_at_ms=${row.yolo_expires_at_ms || '<none>'}\nqueue_depth=${row.queue_depth}\npending_approvals=${row.pending_approvals}`;
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

async fn mission_control_page() -> impl IntoResponse {
    Html(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>TITAN Mission Control</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #f7f9fc; color: #14213d; }
    h1 { margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card { background: white; border: 1px solid #dfe7f3; border-radius: 10px; padding: 12px; }
    pre { white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>TITAN Mission Control</h1>
  <p>Runtime truth from SQLite + channel status probes.</p>
  <div id="yolo_banner" style="display:none; background:#b00020; color:#fff; padding:10px; border-radius:8px; margin-bottom:12px;"></div>
  <div class="grid">
    <div class="card"><h3>Runtime</h3><pre id="runtime"></pre></div>
    <div class="card"><h3>Channels</h3><pre id="channels"></pre></div>
    <div class="card"><h3>Sessions</h3><pre id="sessions"></pre></div>
    <div class="card"><h3>Pending Approvals</h3><pre id="approvals"></pre></div>
    <div class="card"><h3>Connectors</h3><pre id="connectors"></pre></div>
    <div class="card"><h3>Installed Skills</h3><pre id="skills"></pre></div>
    <div class="card"><h3>Recent Runs</h3><pre id="runs"></pre></div>
    <div class="card"><h3>Recent Traces</h3><pre id="traces"></pre></div>
  </div>
  <script>
    async function load() {
      const res = await fetch('/api/mission-control');
      const data = await res.json();
      document.getElementById('runtime').textContent = `mode=${data.mode}\nrisk_mode=${data.risk_mode}\nyolo_expires_at_ms=${data.yolo_expires_at_ms || '<none>'}`;
      const banner = document.getElementById('yolo_banner');
      if (data.risk_mode === 'yolo') {
        banner.style.display = 'block';
        banner.textContent = `YOLO ACTIVE until ${data.yolo_expires_at_ms || '<none>'}. To disable: titan yolo disable`;
      } else {
        banner.style.display = 'none';
        banner.textContent = '';
      }
      document.getElementById('channels').textContent = data.channels.map(c => `${c.channel} configured=${c.configured} status=${c.status}`).join('\n');
      document.getElementById('sessions').textContent = data.sessions.map(s => `${s.id} ${s.channel}/${s.peer_id} queue=${s.queue_depth} compactions=${s.compactions_count}`).join('\n');
      document.getElementById('approvals').textContent = data.pending_approvals.map(a => `${a.id} ${a.tool_name} ${a.capability}`).join('\n');
      document.getElementById('connectors').textContent =
        `total=${data.connector_summary.total} failing=${data.connector_summary.failing}\n` +
        data.connectors.map(c => `${c.id} ${c.connector_type} ${c.display_name} test=${c.last_test_status || '<never>'}`).join('\n');
      document.getElementById('skills').textContent = data.skills.map(s => `${s.slug}@${s.version} signed=${s.signature_status} scopes=${s.scopes}`).join('\n');
      document.getElementById('runs').textContent = data.recent_runs.map(r => `${r.status} ${r.id} ${r.description}`).join('\n');
      document.getElementById('traces').textContent = data.recent_traces.map(t => `${t.goal_id} ${t.event_type} ${t.detail}`).join('\n');
    }
    load();
    setInterval(load, 3000);
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
    let _expired = store.apply_yolo_expiry("web").map_err(internal_error)?;
    let risk = store.get_runtime_risk_state().map_err(internal_error)?;
    let queue_depth = store.count_active_goals().map_err(internal_error)?;
    let pending_approvals = store
        .list_pending_approvals()
        .map_err(internal_error)?
        .len();
    Ok(Json(RuntimeStatusDto {
        mode: state.mode.clone(),
        queue_depth,
        pending_approvals,
        risk_mode: risk.risk_mode.as_str().to_string(),
        yolo_expires_at_ms: risk.yolo_expires_at_ms,
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
            risk_mode: t.risk_mode,
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
            risk_mode: t.risk_mode,
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

async fn api_connectors(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ConnectorDto>>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let rows = store
        .list_connectors()
        .map_err(internal_error)?
        .into_iter()
        .map(|row| ConnectorDto {
            id: row.id,
            connector_type: row.connector_type,
            display_name: row.display_name,
            last_test_at_ms: row.last_test_at_ms,
            last_test_status: row.last_test_status,
        })
        .collect::<Vec<_>>();
    Ok(Json(rows))
}

async fn api_connector_test(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let resolver = CompositeSecretResolver::from_env().map_err(internal_error)?;
    let health = test_connector(&store, &id, &resolver).map_err(internal_error)?;
    Ok(Json(serde_json::json!({
        "connector_id": id,
        "ok": health.ok,
        "detail": health.detail,
    })))
}

async fn api_mission_control(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MissionControlDto>, (StatusCode, String)> {
    let store = open_store(&state)?;
    let _expired = store.apply_yolo_expiry("web").map_err(internal_error)?;
    let risk = store.get_runtime_risk_state().map_err(internal_error)?;
    let channels = ChannelKind::all()
        .iter()
        .map(|channel| match channel_status(*channel) {
            Ok(status) => ChannelStatusDto {
                channel: status.channel,
                configured: status.configured,
                status: status.status,
                detail: status.detail,
            },
            Err(err) => ChannelStatusDto {
                channel: channel.as_str().to_string(),
                configured: false,
                status: "error".to_string(),
                detail: err.to_string(),
            },
        })
        .collect::<Vec<_>>();
    let sessions = store
        .list_sessions(50)
        .map_err(internal_error)?
        .into_iter()
        .map(|row| SessionDto {
            id: row.id,
            channel: row.channel,
            peer_id: row.peer_id,
            queue_depth: row.queue_depth,
            compactions_count: row.compactions_count,
        })
        .collect::<Vec<_>>();
    let pending_approvals = store
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
        .collect::<Vec<_>>();
    let connectors = store
        .list_connectors()
        .map_err(internal_error)?
        .into_iter()
        .map(|row| ConnectorDto {
            id: row.id,
            connector_type: row.connector_type,
            display_name: row.display_name,
            last_test_at_ms: row.last_test_at_ms,
            last_test_status: row.last_test_status,
        })
        .collect::<Vec<_>>();
    let connector_summary = ConnectorSummaryDto {
        total: connectors.len(),
        failing: connectors
            .iter()
            .filter(|c| {
                c.last_test_status
                    .as_deref()
                    .is_some_and(|status| status.starts_with("error:"))
            })
            .count(),
    };
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
    let recent_runs = store
        .list_goals(30)
        .map_err(internal_error)?
        .into_iter()
        .map(|g| GoalDto {
            id: g.id,
            description: g.description,
            status: g.status,
            dedupe_key: g.dedupe_key,
        })
        .collect::<Vec<_>>();
    let recent_traces = store
        .list_recent_traces(50)
        .map_err(internal_error)?
        .into_iter()
        .map(|t| TraceDto {
            goal_id: t.goal_id,
            event_type: t.event_type,
            detail: t.detail,
            risk_mode: t.risk_mode,
        })
        .collect::<Vec<_>>();
    Ok(Json(MissionControlDto {
        mode: state.mode.clone(),
        risk_mode: risk.risk_mode.as_str().to_string(),
        yolo_expires_at_ms: risk.yolo_expires_at_ms,
        channels,
        sessions,
        pending_approvals,
        connectors,
        connector_summary,
        skills,
        recent_runs,
        recent_traces,
    }))
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
    let _expired = store.apply_yolo_expiry("web").map_err(internal_error)?;
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

    if approval.tool_name == "connector_tool" {
        let resolver = CompositeSecretResolver::from_env().map_err(internal_error)?;
        let outcome =
            execute_connector_tool_after_approval(&store, "web", &approval.input, &resolver)
                .map_err(internal_error)?;
        return Ok(Json(DecisionOutput {
            status: "approved".to_string(),
            detail: format!(
                "connector_goal={} status={}",
                outcome.goal_id, outcome.result_status
            ),
        }));
    }

    let registry = ToolRegistry::with_defaults();
    let Some(tool) = registry.get(&approval.tool_name) else {
        return Ok(Json(DecisionOutput {
            status: "approved_no_tool".to_string(),
            detail: approval.tool_name,
        }));
    };

    let mut exec_ctx = ToolExecutionContext::default_for_workspace(state.workspace_root.clone());
    let risk = store.get_runtime_risk_state().map_err(internal_error)?;
    exec_ctx.bypass_path_guard = matches!(risk.risk_mode, titan_memory::RiskMode::Yolo)
        && risk.yolo_bypass_path_guard
        && state.yolo_bypass_path_guard;
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tempfile::tempdir;
    use tower::ServiceExt;

    #[tokio::test]
    async fn mission_control_payload_includes_sessions_skills_and_traces() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let db_path = workspace.join("titan.db");
        let store = MemoryStore::open(&db_path).expect("store");
        let session = store
            .create_session("webchat", "tester", None)
            .expect("create session");
        store
            .upsert_installed_skill(&titan_memory::InstalledSkillRecord {
                slug: "list-docs".to_string(),
                name: "List Docs".to_string(),
                version: "1.0.0".to_string(),
                description: "demo".to_string(),
                source: "local".to_string(),
                hash: "abcd".to_string(),
                signature_status: "unsigned".to_string(),
                scopes: "READ".to_string(),
                allowed_paths: ".".to_string(),
                allowed_hosts: "".to_string(),
                last_run_goal_id: None,
            })
            .expect("skill row");
        let goal = titan_core::Goal::new("demo goal".to_string());
        store
            .create_goal_for_session(&goal, Some(&session.id))
            .expect("goal");
        store
            .add_trace_event(&titan_core::TraceEvent::new(
                goal.id.clone(),
                "demo_event",
                "ok".to_string(),
            ))
            .expect("trace");
        store
            .add_connector(
                "11111111-1111-1111-1111-111111111111",
                "github",
                "GitHub",
                r#"{"owner":"acme","repo":"titan","base_url":"https://api.github.com"}"#,
            )
            .expect("connector");
        store
            .record_connector_test("11111111-1111-1111-1111-111111111111", "ok: healthy")
            .expect("connector test");

        let state = Arc::new(AppState {
            db_path: db_path.clone(),
            workspace_root: workspace.clone(),
            mode: "collaborative".to_string(),
            yolo_bypass_path_guard: true,
        });
        let app = app_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/mission-control")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(parsed["mode"], "collaborative");
        assert!(
            parsed["sessions"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        );
        assert!(
            parsed["skills"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        );
        assert!(
            parsed["connectors"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        );
        assert!(
            parsed["recent_traces"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        );
    }

    #[tokio::test]
    async fn connectors_endpoint_returns_rows() {
        let tmp = tempdir().expect("tempdir");
        let workspace = tmp.path().join("ws");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let db_path = workspace.join("titan.db");
        let store = MemoryStore::open(&db_path).expect("store");
        store
            .add_connector(
                "22222222-2222-2222-2222-222222222222",
                "google_calendar",
                "Calendar",
                r#"{"calendar_id":"primary","base_url":"https://example.test","access_token_env":"GCAL_TOKEN"}"#,
            )
            .expect("connector");

        let state = Arc::new(AppState {
            db_path: db_path.clone(),
            workspace_root: workspace.clone(),
            mode: "collaborative".to_string(),
            yolo_bypass_path_guard: true,
        });
        let app = app_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/connectors")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert!(parsed.as_array().is_some_and(|rows| !rows.is_empty()));
    }
}
