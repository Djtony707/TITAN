use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use titan_common::AutonomyMode;
use titan_common::path_guard::{
    canonicalize_existing_dir, resolve_existing_path_within, resolve_write_path_within,
};
use url::Url;
use wait_timeout::ChildExt;
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityClass {
    Read,
    Write,
    Exec,
    Net,
}

impl CapabilityClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Exec => "exec",
            Self::Net => "net",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    pub name: String,
    pub class: CapabilityClass,
}

impl ToolDescriptor {
    pub fn new(name: impl Into<String>, class: CapabilityClass) -> Self {
        Self {
            name: name.into(),
            class,
        }
    }
}

#[derive(Debug, Default)]
pub struct ToolRegistry {
    tools: Vec<ToolDescriptor>,
}

impl ToolRegistry {
    pub fn with_defaults() -> Self {
        let tools = vec![
            ToolDescriptor::new("list_dir", CapabilityClass::Read),
            ToolDescriptor::new("read_file", CapabilityClass::Read),
            ToolDescriptor::new("search_text", CapabilityClass::Read),
            ToolDescriptor::new("write_file", CapabilityClass::Write),
            ToolDescriptor::new("run_command", CapabilityClass::Exec),
            ToolDescriptor::new("http_get", CapabilityClass::Net),
        ];
        Self { tools }
    }

    pub fn list(&self) -> &[ToolDescriptor] {
        &self.tools
    }

    pub fn get(&self, name: &str) -> Option<&ToolDescriptor> {
        self.tools.iter().find(|tool| tool.name == name)
    }
}

pub struct PolicyEngine;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRiskMode {
    Secure,
    Yolo,
}

impl PolicyEngine {
    pub fn requires_approval(mode: AutonomyMode, class: CapabilityClass) -> bool {
        Self::requires_approval_with_risk(mode, ToolRiskMode::Secure, class)
    }

    pub fn requires_approval_with_risk(
        mode: AutonomyMode,
        risk_mode: ToolRiskMode,
        class: CapabilityClass,
    ) -> bool {
        if matches!(risk_mode, ToolRiskMode::Yolo) {
            return false;
        }
        match mode {
            AutonomyMode::Supervised => true,
            AutonomyMode::Collaborative => !matches!(class, CapabilityClass::Read),
            AutonomyMode::Autonomous => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolExecutionResult {
    pub status: String,
    pub output: String,
}

#[derive(Debug, Clone)]
pub struct ToolExecutionContext {
    pub workspace_root: PathBuf,
    pub command_allowlist: HashSet<String>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub bypass_path_guard: bool,
}

impl ToolExecutionContext {
    pub fn default_for_workspace(workspace_root: PathBuf) -> Self {
        let command_allowlist = ["ls", "cat", "echo", "pwd", "rg", "git"]
            .iter()
            .map(|v| (*v).to_string())
            .collect();
        Self {
            workspace_root,
            command_allowlist,
            timeout_ms: 10_000,
            max_output_bytes: 64 * 1024,
            bypass_path_guard: false,
        }
    }
}

pub struct ToolExecutor;

impl ToolExecutor {
    pub fn execute(
        tool: &ToolDescriptor,
        input: Option<&str>,
        ctx: &ToolExecutionContext,
    ) -> Result<ToolExecutionResult> {
        // Safety boundary for all file/process tools: never operate outside workspace root.
        let workspace_root = canonicalize_existing_dir(&ctx.workspace_root)?;
        let raw_input = input.unwrap_or("").trim();

        let output = match tool.name.as_str() {
            "list_dir" => exec_list_dir(&workspace_root, raw_input, ctx.bypass_path_guard)?,
            "read_file" => exec_read_file(
                &workspace_root,
                raw_input,
                ctx.max_output_bytes,
                ctx.bypass_path_guard,
            )?,
            "search_text" => exec_search_text(
                &workspace_root,
                raw_input,
                ctx.max_output_bytes,
                ctx.bypass_path_guard,
            )?,
            "write_file" => exec_write_file(&workspace_root, raw_input, ctx.bypass_path_guard)?,
            "run_command" => exec_run_command(&workspace_root, raw_input, ctx)?,
            "http_get" => exec_http_get(raw_input, ctx.timeout_ms, ctx.max_output_bytes)?,
            other => bail!("unsupported tool: {other}"),
        };

        Ok(ToolExecutionResult {
            status: "success".to_string(),
            output,
        })
    }
}

fn exec_list_dir(root: &Path, input: &str, bypass_path_guard: bool) -> Result<String> {
    let dir = resolve_existing_path(root, input, bypass_path_guard)?;
    if !dir.is_dir() {
        bail!("list_dir target is not a directory: {}", dir.display());
    }
    let mut entries = fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let file_type = entry.file_type().ok();
            let marker = if file_type.map(|ft| ft.is_dir()).unwrap_or(false) {
                "/"
            } else {
                ""
            };
            format!("{}{}", entry.file_name().to_string_lossy(), marker)
        })
        .collect::<Vec<_>>();
    entries.sort();
    Ok(entries.join("\n"))
}

fn exec_read_file(
    root: &Path,
    input: &str,
    max_output_bytes: usize,
    bypass_path_guard: bool,
) -> Result<String> {
    let file = resolve_existing_path(root, input, bypass_path_guard)?;
    if !file.is_file() {
        bail!("read_file target is not a file: {}", file.display());
    }
    let bytes = fs::read(&file)?;
    let truncated = if bytes.len() > max_output_bytes {
        &bytes[..max_output_bytes]
    } else {
        &bytes
    };
    Ok(String::from_utf8_lossy(truncated).to_string())
}

fn exec_search_text(
    root: &Path,
    input: &str,
    max_output_bytes: usize,
    bypass_path_guard: bool,
) -> Result<String> {
    let (pattern, scope_raw) = match input.split_once("::") {
        Some((pat, scope)) => (pat.trim(), scope.trim()),
        None => (input.trim(), ""),
    };
    if pattern.is_empty() {
        bail!("search_text requires a non-empty pattern");
    }
    let scope = resolve_existing_path(root, scope_raw, bypass_path_guard)?;
    if !scope.exists() {
        bail!("search scope does not exist");
    }

    let mut results = Vec::new();
    for entry in WalkDir::new(scope).follow_links(false) {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        for (line_no, line) in content.lines().enumerate() {
            if line.contains(pattern) {
                let rel = path.strip_prefix(root).unwrap_or(path);
                results.push(format!("{}:{}:{}", rel.display(), line_no + 1, line.trim()));
                if results.len() >= 200 {
                    break;
                }
            }
        }
        if results.len() >= 200 {
            break;
        }
    }

    let mut output = results.join("\n");
    if output.len() > max_output_bytes {
        output.truncate(max_output_bytes);
    }
    Ok(output)
}

fn exec_write_file(root: &Path, input: &str, bypass_path_guard: bool) -> Result<String> {
    let (raw_path, content) = input
        .split_once("::")
        .ok_or_else(|| anyhow!("write_file expects '<path>::<content>'"))?;
    let file = resolve_write_path(root, raw_path, bypass_path_guard)?;
    fs::write(&file, content.as_bytes())?;
    Ok(format!("wrote {}", file.display()))
}

fn exec_run_command(root: &Path, input: &str, ctx: &ToolExecutionContext) -> Result<String> {
    if input.trim().is_empty() {
        bail!("run_command requires input command");
    }
    let args = shlex::split(input).ok_or_else(|| anyhow!("invalid command input"))?;
    if args.is_empty() {
        bail!("run_command requires input command");
    }
    let command = &args[0];
    if !ctx.command_allowlist.contains(command) {
        bail!("command '{}' is not in allowlist", command);
    }

    let mut child = Command::new(command)
        .args(args.iter().skip(1))
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn command '{}'", command))?;

    let timeout = Duration::from_millis(ctx.timeout_ms);
    let timed_out = child.wait_timeout(timeout)?.is_none();
    if timed_out {
        let _ = child.kill();
        let _ = child.wait();
        bail!("command timed out after {}ms", ctx.timeout_ms);
    }

    let output = child.wait_with_output()?;
    let mut merged = Vec::new();
    merged.extend_from_slice(&output.stdout);
    if !output.stderr.is_empty() {
        merged.extend_from_slice(b"\n--- stderr ---\n");
        merged.extend_from_slice(&output.stderr);
    }
    if merged.len() > ctx.max_output_bytes {
        merged.truncate(ctx.max_output_bytes);
    }
    Ok(String::from_utf8_lossy(&merged).to_string())
}

fn exec_http_get(input: &str, timeout_ms: u64, max_output_bytes: usize) -> Result<String> {
    let url = Url::parse(input).with_context(|| "invalid URL")?;
    if url.scheme() != "https" {
        bail!("only https URLs are allowed");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("URL must include a host"))?
        .to_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        bail!("localhost/local network hosts are not allowed");
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_private() || v4.is_loopback() || v4.is_link_local() {
                    bail!("private/loopback IPs are not allowed");
                }
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unique_local() || v6.is_unspecified() {
                    bail!("private/loopback IPs are not allowed");
                }
            }
        }
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()?;
    let response = client.get(url).send()?;
    let status = response.status();
    let mut limited = response.take(max_output_bytes as u64);
    let mut body = Vec::new();
    limited.read_to_end(&mut body)?;
    Ok(format!(
        "status: {}\n{}",
        status.as_u16(),
        String::from_utf8_lossy(&body)
    ))
}

fn resolve_existing_path(root: &Path, input: &str, bypass_path_guard: bool) -> Result<PathBuf> {
    if !bypass_path_guard {
        return resolve_existing_path_within(root, input);
    }
    let raw = input.trim();
    if raw.is_empty() || raw == "." {
        return Ok(root.to_path_buf());
    }
    let candidate = PathBuf::from(raw);
    let path = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    Ok(path.canonicalize()?)
}

fn resolve_write_path(root: &Path, input: &str, bypass_path_guard: bool) -> Result<PathBuf> {
    if !bypass_path_guard {
        return resolve_write_path_within(root, input);
    }
    let raw = input.trim();
    if raw.is_empty() {
        return Ok(root.to_path_buf());
    }
    let candidate = PathBuf::from(raw);
    let path = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn blocks_path_escape_on_read() {
        let tmp = tempdir().expect("tempdir");
        let ctx = ToolExecutionContext::default_for_workspace(tmp.path().to_path_buf());
        let tool = ToolDescriptor::new("read_file", CapabilityClass::Read);
        let result = ToolExecutor::execute(&tool, Some("/etc/hosts"), &ctx);
        assert!(result.is_err());
    }

    #[test]
    fn blocks_non_allowlisted_commands() {
        let tmp = tempdir().expect("tempdir");
        let ctx = ToolExecutionContext::default_for_workspace(tmp.path().to_path_buf());
        let tool = ToolDescriptor::new("run_command", CapabilityClass::Exec);
        let result = ToolExecutor::execute(&tool, Some("python -V"), &ctx);
        assert!(result.is_err());
    }
}
