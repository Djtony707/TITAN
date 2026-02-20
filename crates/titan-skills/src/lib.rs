use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use titan_common::path_guard::canonicalize_existing_dir;
use wait_timeout::ChildExt;
use wasmparser::{Validator, WasmFeatures};

#[derive(Debug, Clone, Deserialize)]
pub struct SkillManifest {
    pub name: String,
    pub version: String,
    pub entrypoint: String,
    #[serde(default)]
    pub capabilities: SkillCapabilities,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SkillCapabilities {
    #[serde(default)]
    pub filesystem: Vec<String>,
    #[serde(default)]
    pub network: bool,
    #[serde(default)]
    pub environment: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SkillPackage {
    pub root: PathBuf,
    pub manifest: SkillManifest,
    pub wasm_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SkillRuntime {
    pub workspace_root: PathBuf,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone)]
pub struct SkillRunResult {
    pub status: String,
    pub output: String,
}

impl SkillPackage {
    pub fn load(skill_dir: &Path) -> Result<Self> {
        let root = skill_dir.canonicalize().with_context(|| {
            format!("failed to resolve skill directory {}", skill_dir.display())
        })?;
        let manifest_path = root.join("manifest.toml");
        let manifest_raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("missing manifest at {}", manifest_path.display()))?;
        let manifest: SkillManifest = toml::from_str(&manifest_raw)
            .with_context(|| format!("failed to parse {}", manifest_path.display()))?;

        let wasm_path = root.join(&manifest.entrypoint);
        if !wasm_path.exists() {
            bail!("skill entrypoint wasm missing: {}", wasm_path.display());
        }
        validate_wasm_binary(&wasm_path)?;

        Ok(Self {
            root,
            manifest,
            wasm_path,
        })
    }
}

impl SkillRuntime {
    pub fn run(&self, package: &SkillPackage, args: &[String]) -> Result<SkillRunResult> {
        let workspace_root = canonicalize_existing_dir(&self.workspace_root)?;

        // The wasmtime CLI is used as the sandbox executor:
        // - no inherited environment by default
        // - only whitelisted env vars passed through
        // - workspace directory mounted explicitly
        // - process timeout enforced by TITAN runtime
        let mut cmd = Command::new("wasmtime");
        cmd.arg("run")
            .arg(format!("--dir={}", workspace_root.display()))
            .arg(&package.wasm_path);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.current_dir(&workspace_root);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.env_clear();

        for key in &package.manifest.capabilities.environment {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }

        if package.manifest.capabilities.network {
            // Network capability is declared for future policy routing.
            // Default WASI execution remains network-isolated here.
        }

        let mut child = cmd
            .spawn()
            .with_context(|| "failed to start wasmtime; ensure it is installed")?;

        if child
            .wait_timeout(Duration::from_millis(self.timeout_ms))?
            .is_none()
        {
            let _ = child.kill();
            let _ = child.wait();
            bail!("skill execution timed out after {}ms", self.timeout_ms);
        }

        let output = child.wait_with_output()?;
        let mut merged = String::new();
        merged.push_str(&String::from_utf8_lossy(&output.stdout));
        if !output.stderr.is_empty() {
            merged.push_str("\n--- stderr ---\n");
            merged.push_str(&String::from_utf8_lossy(&output.stderr));
        }

        let status = if output.status.success() {
            "success".to_string()
        } else {
            format!("failed({})", output.status.code().unwrap_or(-1))
        };
        Ok(SkillRunResult {
            status,
            output: merged,
        })
    }
}

pub fn validate_wasm_binary(path: &Path) -> Result<()> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    let mut validator = Validator::new_with_features(WasmFeatures::default());
    validator
        .validate_all(&bytes)
        .map_err(|e| anyhow!("invalid wasm binary: {e}"))?;
    Ok(())
}
