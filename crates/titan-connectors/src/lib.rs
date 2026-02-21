use std::collections::BTreeMap;

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use titan_common::AutonomyMode;
use titan_core::{Goal, GoalStatus, TraceEvent};
use titan_memory::{MemoryStore, RiskMode};
use titan_tools::{CapabilityClass, PolicyEngine, ToolRiskMode};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorType {
    Github,
    GoogleCalendar,
}

impl ConnectorType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::GoogleCalendar => "google_calendar",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "github" => Some(Self::Github),
            "google_calendar" | "google-calendar" | "gcal" => Some(Self::GoogleCalendar),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectorScopes {
    pub read: bool,
    pub write: bool,
    pub net: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorHealth {
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct ConnectorToolDescriptor {
    pub name: String,
    pub description: String,
    pub required_scopes: ConnectorScopes,
    pub risk_class: CapabilityClass,
}

#[derive(Debug, Clone)]
pub struct ConnectorToolResult {
    pub status: String,
    pub output_json: Value,
    pub metadata_json: Value,
}

pub struct ConnectorContext<'a> {
    pub connector_id: &'a str,
    pub config: &'a Value,
    pub secret_resolver: &'a dyn SecretResolver,
}

pub trait SecretResolver {
    fn get_secret(&self, key_id: &str) -> Result<Option<String>>;
}

#[derive(Default)]
pub struct InMemorySecretResolver {
    secrets: BTreeMap<String, String>,
}

impl InMemorySecretResolver {
    pub fn new(secrets: BTreeMap<String, String>) -> Self {
        Self { secrets }
    }
}

impl SecretResolver for InMemorySecretResolver {
    fn get_secret(&self, key_id: &str) -> Result<Option<String>> {
        Ok(self.secrets.get(key_id).cloned())
    }
}

pub trait Connector: Send + Sync {
    fn id(&self) -> Uuid;
    fn connector_type(&self) -> ConnectorType;
    fn display_name(&self) -> &str;
    fn required_scopes(&self) -> ConnectorScopes;
    fn health_check(&self, ctx: &ConnectorContext<'_>) -> Result<ConnectorHealth>;
    fn tools(&self) -> Vec<ConnectorToolDescriptor>;
    fn execute_tool(
        &self,
        tool_name: &str,
        input: &Value,
        ctx: &ConnectorContext<'_>,
    ) -> Result<ConnectorToolResult>;
}

#[derive(Debug, Clone)]
pub struct ConnectorActionOutcome {
    pub goal_id: String,
    pub approval_id: Option<String>,
    pub executed: bool,
    pub result_status: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApprovalPayload {
    connector_id: String,
    tool_name: String,
    input: Value,
}

pub fn execute_connector_tool_mediated(
    store: &MemoryStore,
    mode: AutonomyMode,
    actor: &str,
    connector_id: &str,
    tool_name: &str,
    input: Value,
    secret_resolver: &dyn SecretResolver,
) -> Result<ConnectorActionOutcome> {
    store.apply_yolo_expiry("connector")?;
    let risk = store.get_runtime_risk_state()?;
    let connector = load_connector(store, connector_id)?;
    let descriptor = connector
        .tools()
        .into_iter()
        .find(|item| item.name == tool_name)
        .ok_or_else(|| anyhow!("unknown connector tool: {tool_name}"))?;
    let risk_mode = if matches!(risk.risk_mode, RiskMode::Yolo) {
        ToolRiskMode::Yolo
    } else {
        ToolRiskMode::Secure
    };
    let needs_approval =
        PolicyEngine::requires_approval_with_risk(mode, risk_mode, descriptor.risk_class);

    let goal = Goal::new(format!("connector:{}:{}", connector_id, tool_name));
    store.create_goal(&goal)?;
    let trace_base = serde_json::json!({
        "connector_id": connector_id,
        "tool_name": tool_name,
        "risk_mode": risk.risk_mode.as_str(),
        "input": sanitize_input_for_trace(&input)
    });
    store.add_trace_event(
        &TraceEvent::new(
            goal.id.clone(),
            "connector_tool_requested",
            serde_json::to_string(&trace_base)?,
        )
        .with_risk_mode(risk.risk_mode.as_str()),
    )?;

    if needs_approval {
        let approval = store.create_approval_request_for_goal(
            Some(&goal.id),
            "connector_tool",
            descriptor.risk_class.as_str(),
            &serde_json::to_string(&ApprovalPayload {
                connector_id: connector_id.to_string(),
                tool_name: tool_name.to_string(),
                input,
            })?,
            Some(actor),
            300_000,
        )?;
        store.update_goal_status(&goal.id, GoalStatus::Planning)?;
        return Ok(ConnectorActionOutcome {
            goal_id: goal.id,
            approval_id: Some(approval.id),
            executed: false,
            result_status: "pending_approval".to_string(),
        });
    }

    execute_connector_tool_now(ExecuteNowArgs {
        store,
        connector: connector.as_ref(),
        goal_id: &goal.id,
        connector_id,
        tool_name,
        input,
        risk_mode: risk.risk_mode,
        secret_resolver,
    })?;

    Ok(ConnectorActionOutcome {
        goal_id: goal.id,
        approval_id: None,
        executed: true,
        result_status: "success".to_string(),
    })
}

pub fn execute_connector_tool_after_approval(
    store: &MemoryStore,
    actor: &str,
    payload_json: &str,
    secret_resolver: &dyn SecretResolver,
) -> Result<ConnectorActionOutcome> {
    let payload: ApprovalPayload =
        serde_json::from_str(payload_json).with_context(|| "invalid connector approval payload")?;
    let connector = load_connector(store, &payload.connector_id)?;
    let risk = store.get_runtime_risk_state()?;
    let goal = Goal::new(format!(
        "connector:{}:{}:approved:{}",
        payload.connector_id, payload.tool_name, actor
    ));
    store.create_goal(&goal)?;

    execute_connector_tool_now(ExecuteNowArgs {
        store,
        connector: connector.as_ref(),
        goal_id: &goal.id,
        connector_id: &payload.connector_id,
        tool_name: &payload.tool_name,
        input: payload.input,
        risk_mode: risk.risk_mode,
        secret_resolver,
    })?;

    Ok(ConnectorActionOutcome {
        goal_id: goal.id,
        approval_id: None,
        executed: true,
        result_status: "success".to_string(),
    })
}

fn execute_connector_tool_now(args: ExecuteNowArgs<'_>) -> Result<()> {
    let config = connector_config_value(args.store, args.connector_id)?;
    let ctx = ConnectorContext {
        connector_id: args.connector_id,
        config: &config,
        secret_resolver: args.secret_resolver,
    };
    let result = args
        .connector
        .execute_tool(args.tool_name, &args.input, &ctx)?;
    args.store
        .update_goal_status(args.goal_id, GoalStatus::Completed)?;
    args.store.record_connector_tool_usage(
        args.connector_id,
        args.tool_name,
        Some(args.goal_id),
    )?;
    args.store.add_trace_event(
        &TraceEvent::new(
            args.goal_id.to_string(),
            "connector_tool_result",
            serde_json::to_string(&serde_json::json!({
                "connector_id": args.connector_id,
                "tool_name": args.tool_name,
                "status": result.status,
                "risk_mode": args.risk_mode.as_str(),
                "metadata": result.metadata_json,
            }))?,
        )
        .with_risk_mode(args.risk_mode.as_str()),
    )?;
    Ok(())
}

struct ExecuteNowArgs<'a> {
    store: &'a MemoryStore,
    connector: &'a dyn Connector,
    goal_id: &'a str,
    connector_id: &'a str,
    tool_name: &'a str,
    input: Value,
    risk_mode: RiskMode,
    secret_resolver: &'a dyn SecretResolver,
}

pub fn test_connector(
    store: &MemoryStore,
    connector_id: &str,
    secret_resolver: &dyn SecretResolver,
) -> Result<ConnectorHealth> {
    let connector = load_connector(store, connector_id)?;
    let config = connector_config_value(store, connector_id)?;
    let ctx = ConnectorContext {
        connector_id,
        config: &config,
        secret_resolver,
    };
    let health = connector.health_check(&ctx)?;
    let status = if health.ok {
        format!("ok: {}", health.detail)
    } else {
        format!("error: {}", health.detail)
    };
    let _ = store.record_connector_test(connector_id, &status)?;
    Ok(health)
}

pub fn connector_tools(connector_type: ConnectorType) -> Vec<ConnectorToolDescriptor> {
    match connector_type {
        ConnectorType::Github => GitHubConnector::tools_static(),
        ConnectorType::GoogleCalendar => GoogleCalendarConnector::tools_static(),
    }
}

pub fn load_connector(store: &MemoryStore, connector_id: &str) -> Result<Box<dyn Connector>> {
    let row = store
        .get_connector(connector_id)?
        .ok_or_else(|| anyhow!("connector not found: {connector_id}"))?;
    let parsed = ConnectorType::parse(&row.connector_type)
        .ok_or_else(|| anyhow!("unsupported connector type: {}", row.connector_type))?;
    let id = Uuid::parse_str(&row.id).with_context(|| "connector id is not a valid UUID")?;
    match parsed {
        ConnectorType::Github => Ok(Box::new(GitHubConnector {
            id,
            display_name: row.display_name,
        })),
        ConnectorType::GoogleCalendar => Ok(Box::new(GoogleCalendarConnector {
            id,
            display_name: row.display_name,
        })),
    }
}

fn connector_config_value(store: &MemoryStore, connector_id: &str) -> Result<Value> {
    let row = store
        .get_connector(connector_id)?
        .ok_or_else(|| anyhow!("connector not found: {connector_id}"))?;
    serde_json::from_str(&row.config_json)
        .with_context(|| format!("invalid config_json for connector {connector_id}"))
}

fn sanitize_input_for_trace(input: &Value) -> Value {
    if input.is_object() {
        let mut object = input.as_object().cloned().unwrap_or_default();
        for key in ["token", "authorization", "auth", "password", "secret"] {
            if object.contains_key(key) {
                object.insert(key.to_string(), Value::String("<redacted>".to_string()));
            }
        }
        Value::Object(object)
    } else {
        input.clone()
    }
}

#[derive(Debug)]
struct GitHubConnector {
    id: Uuid,
    display_name: String,
}

impl GitHubConnector {
    fn tools_static() -> Vec<ConnectorToolDescriptor> {
        vec![
            ConnectorToolDescriptor {
                name: "github.list_issues".to_string(),
                description: "List issues for configured repo".to_string(),
                required_scopes: ConnectorScopes {
                    read: true,
                    write: false,
                    net: true,
                },
                risk_class: CapabilityClass::Net,
            },
            ConnectorToolDescriptor {
                name: "github.list_prs".to_string(),
                description: "List pull requests for configured repo".to_string(),
                required_scopes: ConnectorScopes {
                    read: true,
                    write: false,
                    net: true,
                },
                risk_class: CapabilityClass::Net,
            },
            ConnectorToolDescriptor {
                name: "github.get_issue".to_string(),
                description: "Get issue by number".to_string(),
                required_scopes: ConnectorScopes {
                    read: true,
                    write: false,
                    net: true,
                },
                risk_class: CapabilityClass::Net,
            },
            ConnectorToolDescriptor {
                name: "github.create_issue".to_string(),
                description: "Create an issue".to_string(),
                required_scopes: ConnectorScopes {
                    read: false,
                    write: true,
                    net: true,
                },
                risk_class: CapabilityClass::Write,
            },
        ]
    }
}

impl Connector for GitHubConnector {
    fn id(&self) -> Uuid {
        self.id
    }

    fn connector_type(&self) -> ConnectorType {
        ConnectorType::Github
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn required_scopes(&self) -> ConnectorScopes {
        ConnectorScopes {
            read: true,
            write: true,
            net: true,
        }
    }

    fn health_check(&self, ctx: &ConnectorContext<'_>) -> Result<ConnectorHealth> {
        let cfg = GitHubConfig::from_value(ctx.config)?;
        let token = resolve_secret(
            ctx.secret_resolver,
            ctx.connector_id,
            "github_token",
            "GITHUB_TOKEN",
        )?;
        let url = format!(
            "{}/repos/{}/{}/issues?per_page=1",
            cfg.base_url, cfg.owner, cfg.repo
        );
        let response = reqwest::blocking::Client::new()
            .get(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", "titan-connectors")
            .send()
            .with_context(|| "github health request failed")?;
        let status = response.status();
        Ok(ConnectorHealth {
            ok: status.is_success(),
            detail: format!("http_status={}", status.as_u16()),
        })
    }

    fn tools(&self) -> Vec<ConnectorToolDescriptor> {
        Self::tools_static()
    }

    fn execute_tool(
        &self,
        tool_name: &str,
        input: &Value,
        ctx: &ConnectorContext<'_>,
    ) -> Result<ConnectorToolResult> {
        let cfg = GitHubConfig::from_value(ctx.config)?;
        let token = resolve_secret(
            ctx.secret_resolver,
            ctx.connector_id,
            "github_token",
            "GITHUB_TOKEN",
        )?;
        let client = reqwest::blocking::Client::new();
        let base = format!("{}/repos/{}/{}", cfg.base_url, cfg.owner, cfg.repo);
        match tool_name {
            "github.list_issues" => {
                let url = format!("{base}/issues?per_page=20");
                let response = client
                    .get(url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "titan-connectors")
                    .send()?;
                let status = response.status();
                let body: Value = response.error_for_status()?.json()?;
                Ok(ConnectorToolResult {
                    status: "success".to_string(),
                    output_json: body,
                    metadata_json: serde_json::json!({"http_status": status.as_u16()}),
                })
            }
            "github.list_prs" => {
                let url = format!("{base}/pulls?per_page=20");
                let response = client
                    .get(url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "titan-connectors")
                    .send()?;
                let status = response.status();
                let body: Value = response.error_for_status()?.json()?;
                Ok(ConnectorToolResult {
                    status: "success".to_string(),
                    output_json: body,
                    metadata_json: serde_json::json!({"http_status": status.as_u16()}),
                })
            }
            "github.get_issue" => {
                let number = input
                    .get("number")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| anyhow!("number is required"))?;
                let url = format!("{base}/issues/{number}");
                let response = client
                    .get(url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "titan-connectors")
                    .send()?;
                let status = response.status();
                let body: Value = response.error_for_status()?.json()?;
                Ok(ConnectorToolResult {
                    status: "success".to_string(),
                    output_json: body,
                    metadata_json: serde_json::json!({"http_status": status.as_u16()}),
                })
            }
            "github.create_issue" => {
                let title = input
                    .get("title")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("title is required"))?;
                let body_text = input
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let url = format!("{base}/issues");
                let response = client
                    .post(url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "titan-connectors")
                    .json(&serde_json::json!({"title": title, "body": body_text}))
                    .send()?;
                let status = response.status();
                let body: Value = response.error_for_status()?.json()?;
                Ok(ConnectorToolResult {
                    status: "success".to_string(),
                    output_json: body,
                    metadata_json: serde_json::json!({"http_status": status.as_u16()}),
                })
            }
            _ => bail!("unsupported github tool: {tool_name}"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GitHubConfig {
    owner: String,
    repo: String,
    #[serde(default = "default_github_base")]
    base_url: String,
}

impl GitHubConfig {
    fn from_value(value: &Value) -> Result<Self> {
        serde_json::from_value(value.clone()).with_context(|| "invalid github connector config")
    }
}

fn default_github_base() -> String {
    "https://api.github.com".to_string()
}

#[derive(Debug)]
struct GoogleCalendarConnector {
    id: Uuid,
    display_name: String,
}

impl GoogleCalendarConnector {
    fn tools_static() -> Vec<ConnectorToolDescriptor> {
        vec![
            ConnectorToolDescriptor {
                name: "gcal.list_upcoming_events".to_string(),
                description: "List upcoming calendar events".to_string(),
                required_scopes: ConnectorScopes {
                    read: true,
                    write: false,
                    net: true,
                },
                risk_class: CapabilityClass::Net,
            },
            ConnectorToolDescriptor {
                name: "gcal.create_event".to_string(),
                description: "Create calendar event".to_string(),
                required_scopes: ConnectorScopes {
                    read: false,
                    write: true,
                    net: true,
                },
                risk_class: CapabilityClass::Write,
            },
        ]
    }
}

impl Connector for GoogleCalendarConnector {
    fn id(&self) -> Uuid {
        self.id
    }

    fn connector_type(&self) -> ConnectorType {
        ConnectorType::GoogleCalendar
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn required_scopes(&self) -> ConnectorScopes {
        ConnectorScopes {
            read: true,
            write: true,
            net: true,
        }
    }

    fn health_check(&self, ctx: &ConnectorContext<'_>) -> Result<ConnectorHealth> {
        let cfg = GoogleCalendarConfig::from_value(ctx.config)?;
        if cfg.access_token_env.is_none()
            && ctx
                .secret_resolver
                .get_secret(&format!("connector:{}:gcal_token", ctx.connector_id))?
                .is_none()
        {
            return Ok(ConnectorHealth {
                ok: false,
                detail: "needs_oauth_or_token".to_string(),
            });
        }
        Ok(ConnectorHealth {
            ok: true,
            detail: "configured".to_string(),
        })
    }

    fn tools(&self) -> Vec<ConnectorToolDescriptor> {
        Self::tools_static()
    }

    fn execute_tool(
        &self,
        tool_name: &str,
        input: &Value,
        ctx: &ConnectorContext<'_>,
    ) -> Result<ConnectorToolResult> {
        let cfg = GoogleCalendarConfig::from_value(ctx.config)?;
        let token = resolve_secret(
            ctx.secret_resolver,
            ctx.connector_id,
            "gcal_token",
            cfg.access_token_env
                .as_deref()
                .unwrap_or("GOOGLE_CALENDAR_TOKEN"),
        )?;
        let client = reqwest::blocking::Client::new();
        let base = cfg
            .base_url
            .unwrap_or_else(|| "https://www.googleapis.com/calendar/v3".to_string());
        match tool_name {
            "gcal.list_upcoming_events" => {
                let url = format!(
                    "{}/calendars/{}/events?maxResults=10&singleEvents=true&orderBy=startTime",
                    base, cfg.calendar_id
                );
                let response = client
                    .get(url)
                    .header("Authorization", format!("Bearer {token}"))
                    .send()?;
                let status = response.status();
                let body: Value = response.error_for_status()?.json()?;
                Ok(ConnectorToolResult {
                    status: "success".to_string(),
                    output_json: body,
                    metadata_json: serde_json::json!({"http_status": status.as_u16()}),
                })
            }
            "gcal.create_event" => {
                let summary = input
                    .get("summary")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("summary is required"))?;
                let start = input
                    .get("start")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("start is required"))?;
                let end = input
                    .get("end")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("end is required"))?;
                let url = format!("{}/calendars/{}/events", base, cfg.calendar_id);
                let response = client
                    .post(url)
                    .header("Authorization", format!("Bearer {token}"))
                    .json(&serde_json::json!({
                        "summary": summary,
                        "start": {"dateTime": start},
                        "end": {"dateTime": end}
                    }))
                    .send()?;
                let status = response.status();
                let body: Value = response.error_for_status()?.json()?;
                Ok(ConnectorToolResult {
                    status: "success".to_string(),
                    output_json: body,
                    metadata_json: serde_json::json!({"http_status": status.as_u16()}),
                })
            }
            _ => bail!("unsupported gcal tool: {tool_name}"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GoogleCalendarConfig {
    calendar_id: String,
    #[serde(default)]
    access_token_env: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
}

impl GoogleCalendarConfig {
    fn from_value(value: &Value) -> Result<Self> {
        serde_json::from_value(value.clone())
            .with_context(|| "invalid google_calendar connector config")
    }
}

fn resolve_secret(
    resolver: &dyn SecretResolver,
    connector_id: &str,
    suffix: &str,
    env_key: &str,
) -> Result<String> {
    if let Ok(value) = std::env::var(env_key)
        && !value.trim().is_empty()
    {
        return Ok(value);
    }
    let key_id = format!("connector:{connector_id}:{suffix}");
    let value = resolver.get_secret(&key_id)?;
    value.ok_or_else(|| anyhow!("missing secret {key_id}"))
}
