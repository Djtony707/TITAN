use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

#[derive(Debug, Clone, Deserialize)]
pub struct RegistrySkillManifest {
    pub name: String,
    pub slug: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub entrypoint: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub signature: Option<SkillSignature>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillSignature {
    pub key_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct RegistrySkillPackage {
    pub root: PathBuf,
    pub manifest: RegistrySkillManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillsLock {
    pub version: u32,
    pub entries: Vec<SkillsLockEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillsLockEntry {
    pub slug: String,
    pub version: String,
    pub source: String,
    pub hash: String,
    pub signature_status: String,
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

pub fn default_registry_root() -> PathBuf {
    if let Ok(path) = std::env::var("TITAN_SKILL_REGISTRY")
        && !path.trim().is_empty()
    {
        return PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".titan/registry/local")
}

pub fn default_skills_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".titan/skills")
}

pub fn default_trust_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".titan/trust/keys")
}

pub fn load_registry_skill(path: &Path) -> Result<RegistrySkillPackage> {
    let root = path
        .canonicalize()
        .with_context(|| format!("failed to resolve skill path {}", path.display()))?;
    let manifest_path = root.join("skill.toml");
    let docs_path = root.join("SKILL.md");
    if !docs_path.exists() {
        bail!("missing required SKILL.md in {}", root.display());
    }
    let manifest_raw = fs::read_to_string(&manifest_path)
        .with_context(|| format!("missing skill.toml at {}", manifest_path.display()))?;
    let manifest: RegistrySkillManifest = toml::from_str(&manifest_raw)
        .with_context(|| format!("failed to parse {}", manifest_path.display()))?;
    if manifest.slug.trim().is_empty() {
        bail!("skill.toml slug is required");
    }
    if manifest.version.trim().is_empty() {
        bail!("skill.toml version is required");
    }
    if manifest.entrypoint.trim().is_empty() {
        bail!("skill.toml entrypoint is required");
    }
    Ok(RegistrySkillPackage { root, manifest })
}

pub fn search_registry(registry_root: &Path, query: &str) -> Result<Vec<RegistrySkillManifest>> {
    if !registry_root.exists() {
        return Ok(Vec::new());
    }
    let needle = query.trim().to_ascii_lowercase();
    let mut hits = Vec::new();
    for entry in walkdir::WalkDir::new(registry_root)
        .follow_links(false)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_file() || entry.file_name() != "skill.toml" {
            continue;
        }
        let manifest_raw = match fs::read_to_string(entry.path()) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let parsed = match toml::from_str::<RegistrySkillManifest>(&manifest_raw) {
            Ok(item) => item,
            Err(_) => continue,
        };
        let haystack = format!(
            "{} {} {} {}",
            parsed.slug, parsed.name, parsed.description, parsed.author
        )
        .to_ascii_lowercase();
        if needle.is_empty() || haystack.contains(&needle) {
            hits.push(parsed);
        }
    }
    hits.sort_by(|a, b| a.slug.cmp(&b.slug).then(a.version.cmp(&b.version)));
    Ok(hits)
}

pub fn inspect_registry_skill(
    registry_root: &Path,
    slug: &str,
    version: Option<&str>,
) -> Result<Option<RegistrySkillPackage>> {
    if !registry_root.exists() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for entry in walkdir::WalkDir::new(registry_root)
        .follow_links(false)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_file() || entry.file_name() != "skill.toml" {
            continue;
        }
        let parent = match entry.path().parent() {
            Some(path) => path,
            None => continue,
        };
        let package = match load_registry_skill(parent) {
            Ok(pkg) => pkg,
            Err(_) => continue,
        };
        if package.manifest.slug != slug {
            continue;
        }
        if let Some(v) = version
            && package.manifest.version != v
        {
            continue;
        }
        candidates.push(package);
    }
    candidates.sort_by(|a, b| a.manifest.version.cmp(&b.manifest.version));
    Ok(candidates.pop())
}

pub fn load_skills_lock(path: &Path) -> Result<SkillsLock> {
    if !path.exists() {
        return Ok(SkillsLock {
            version: 1,
            entries: Vec::new(),
        });
    }
    let raw = fs::read_to_string(path)?;
    let lock: SkillsLock = toml::from_str(&raw)?;
    Ok(lock)
}

pub fn save_skills_lock(path: &Path, lock: &SkillsLock) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, toml::to_string_pretty(lock)?)?;
    Ok(())
}

pub fn compute_bundle_hash(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        files.push(entry.path().to_path_buf());
    }
    files.sort();
    for file in files {
        let rel = file
            .strip_prefix(path)
            .unwrap_or(&file)
            .to_string_lossy()
            .to_string();
        hasher.update(rel.as_bytes());
        hasher.update([0_u8]);
        hasher.update(fs::read(&file)?);
        hasher.update([0_u8]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify_signature_status(skill: &RegistrySkillPackage, trust_root: &Path) -> Result<String> {
    if let Some(signature) = &skill.manifest.signature {
        let key_path = trust_root.join(format!("{}.pub", signature.key_id));
        if !key_path.exists() {
            return Ok("untrusted_key".to_string());
        }
        let hash = compute_bundle_hash(&skill.root)?;
        if hash == signature.sha256.to_ascii_lowercase() {
            return Ok("verified".to_string());
        }
        return Ok("invalid_signature".to_string());
    }
    Ok("unsigned".to_string())
}

pub fn install_registry_skill(
    registry_root: &Path,
    skills_root: &Path,
    lock_path: &Path,
    slug: &str,
    version: Option<&str>,
    source_label: &str,
) -> Result<SkillsLockEntry> {
    let package = inspect_registry_skill(registry_root, slug, version)?
        .ok_or_else(|| anyhow!("skill not found: {slug}"))?;
    let target = skills_root
        .join(&package.manifest.slug)
        .join(&package.manifest.version);
    if target.exists() {
        fs::remove_dir_all(&target)?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    copy_dir_recursive(&package.root, &target)?;
    let installed = load_registry_skill(&target)?;
    let hash = compute_bundle_hash(&installed.root)?;
    let signature_status = verify_signature_status(&installed, &default_trust_root())?;
    let mut lock = load_skills_lock(lock_path)?;
    lock.entries
        .retain(|entry| entry.slug != installed.manifest.slug);
    let entry = SkillsLockEntry {
        slug: installed.manifest.slug.clone(),
        version: installed.manifest.version.clone(),
        source: source_label.to_string(),
        hash,
        signature_status,
    };
    lock.entries.push(entry.clone());
    lock.entries.sort_by(|a, b| a.slug.cmp(&b.slug));
    save_skills_lock(lock_path, &lock)?;
    Ok(entry)
}

pub fn list_installed_skills(skills_root: &Path) -> Result<Vec<RegistrySkillPackage>> {
    if !skills_root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(skills_root)
        .follow_links(false)
        .min_depth(2)
        .max_depth(3)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_dir() {
            continue;
        }
        let manifest = entry.path().join("skill.toml");
        if !manifest.exists() {
            continue;
        }
        if let Ok(pkg) = load_registry_skill(entry.path()) {
            out.push(pkg);
        }
    }
    out.sort_by(|a, b| a.manifest.slug.cmp(&b.manifest.slug));
    Ok(out)
}

pub fn remove_installed_skill(skills_root: &Path, lock_path: &Path, slug: &str) -> Result<bool> {
    let slug_dir = skills_root.join(slug);
    if !slug_dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&slug_dir)?;
    let mut lock = load_skills_lock(lock_path)?;
    let before = lock.entries.len();
    lock.entries.retain(|entry| entry.slug != slug);
    if lock.entries.len() != before {
        save_skills_lock(lock_path, &lock)?;
    }
    Ok(true)
}

pub fn parse_skill_permissions(
    manifest: &RegistrySkillManifest,
) -> std::collections::BTreeSet<String> {
    manifest
        .permissions
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = target.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).with_context(|| {
                format!(
                    "failed copying {} to {}",
                    src_path.display(),
                    dst_path.display()
                )
            })?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SkillScope {
    Read,
    Write,
    Exec,
    Net,
}

impl SkillScope {
    pub fn as_capability_class(&self) -> titan_tools::CapabilityClass {
        match self {
            Self::Read => titan_tools::CapabilityClass::Read,
            Self::Write => titan_tools::CapabilityClass::Write,
            Self::Exec => titan_tools::CapabilityClass::Exec,
            Self::Net => titan_tools::CapabilityClass::Net,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "READ",
            Self::Write => "WRITE",
            Self::Exec => "EXEC",
            Self::Net => "NET",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillEntrypointType {
    Prompt,
    Http,
    Wasm,
    ScriptStub,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifestPermissionsV1 {
    pub scopes: Vec<SkillScope>,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSignatureV1 {
    pub public_key_id: String,
    pub ed25519_sig_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifestV1 {
    pub name: String,
    pub slug: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    pub entrypoint_type: SkillEntrypointType,
    pub entrypoint: String,
    pub permissions: SkillManifestPermissionsV1,
    #[serde(default)]
    pub signature: Option<SkillSignatureV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrySkillVersionV1 {
    pub version: String,
    pub download_url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrySkillEntryV1 {
    pub slug: String,
    pub name: String,
    pub latest: String,
    pub versions: Vec<RegistrySkillVersionV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryIndexV1 {
    pub skills: Vec<RegistrySkillEntryV1>,
}

#[derive(Debug, Clone)]
pub struct ResolvedSkillVersion {
    pub slug: String,
    pub name: String,
    pub version: String,
    pub download_url: String,
    pub sha256: String,
}

pub trait SkillRegistryAdapter {
    fn id(&self) -> &str;
    fn fetch_index(&self) -> Result<RegistryIndexV1>;
    fn fetch_bundle_to_dir(
        &self,
        resolved: &ResolvedSkillVersion,
        staging_dir: &Path,
    ) -> Result<PathBuf>;
}

#[derive(Debug, Clone)]
pub struct LocalRegistryAdapter {
    pub root: PathBuf,
}

impl LocalRegistryAdapter {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

impl SkillRegistryAdapter for LocalRegistryAdapter {
    fn id(&self) -> &str {
        "local"
    }

    fn fetch_index(&self) -> Result<RegistryIndexV1> {
        let index_path = self.root.join("index.json");
        let raw = fs::read_to_string(&index_path)
            .with_context(|| format!("failed to read {}", index_path.display()))?;
        serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse {}", index_path.display()))
    }

    fn fetch_bundle_to_dir(
        &self,
        resolved: &ResolvedSkillVersion,
        staging_dir: &Path,
    ) -> Result<PathBuf> {
        let bundle_path = self.root.join(&resolved.download_url);
        let src = canonicalize_existing_dir(&bundle_path).with_context(|| {
            format!(
                "local registry bundle must be directory: {}",
                bundle_path.display()
            )
        })?;
        if staging_dir.exists() {
            fs::remove_dir_all(staging_dir)?;
        }
        copy_dir_recursive(&src, staging_dir)?;
        Ok(staging_dir.to_path_buf())
    }
}

#[derive(Debug, Clone)]
pub struct GitRegistryAdapter {
    pub repo_url: String,
}

impl GitRegistryAdapter {
    pub fn new(repo_url: impl Into<String>) -> Self {
        Self {
            repo_url: repo_url.into(),
        }
    }

    fn clone_repo(&self) -> Result<tempfile::TempDir> {
        let temp = tempfile::tempdir()?;
        let status = std::process::Command::new("git")
            .arg("clone")
            .arg("--depth")
            .arg("1")
            .arg(&self.repo_url)
            .arg(temp.path())
            .status()
            .with_context(|| "failed to run git clone for skill registry")?;
        if !status.success() {
            bail!("git registry clone failed for {}", self.repo_url);
        }
        Ok(temp)
    }
}

impl SkillRegistryAdapter for GitRegistryAdapter {
    fn id(&self) -> &str {
        "git"
    }

    fn fetch_index(&self) -> Result<RegistryIndexV1> {
        let checkout = self.clone_repo()?;
        let index_path = checkout.path().join("index.json");
        let raw = fs::read_to_string(&index_path)
            .with_context(|| format!("failed to read {}", index_path.display()))?;
        serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse {}", index_path.display()))
    }

    fn fetch_bundle_to_dir(
        &self,
        resolved: &ResolvedSkillVersion,
        staging_dir: &Path,
    ) -> Result<PathBuf> {
        let checkout = self.clone_repo()?;
        let bundle_path = checkout.path().join(&resolved.download_url);
        let src = canonicalize_existing_dir(&bundle_path).with_context(|| {
            format!(
                "git registry bundle must be directory in repo checkout: {}",
                bundle_path.display()
            )
        })?;
        if staging_dir.exists() {
            fs::remove_dir_all(staging_dir)?;
        }
        copy_dir_recursive(&src, staging_dir)?;
        Ok(staging_dir.to_path_buf())
    }
}

#[derive(Debug, Clone)]
pub struct HttpRegistryAdapter {
    pub index_url: String,
}

impl HttpRegistryAdapter {
    pub fn new(index_url: impl Into<String>) -> Self {
        Self {
            index_url: index_url.into(),
        }
    }
}

impl SkillRegistryAdapter for HttpRegistryAdapter {
    fn id(&self) -> &str {
        "http"
    }

    fn fetch_index(&self) -> Result<RegistryIndexV1> {
        let raw = reqwest::blocking::Client::new()
            .get(&self.index_url)
            .send()
            .with_context(|| format!("failed to GET {}", self.index_url))?
            .error_for_status()
            .with_context(|| format!("registry returned error for {}", self.index_url))?
            .text()?;
        serde_json::from_str(&raw).with_context(|| "failed to parse HTTP registry index")
    }

    fn fetch_bundle_to_dir(
        &self,
        resolved: &ResolvedSkillVersion,
        _staging_dir: &Path,
    ) -> Result<PathBuf> {
        if resolved.download_url.starts_with("file://") {
            let path = PathBuf::from(resolved.download_url.trim_start_matches("file://"));
            return canonicalize_existing_dir(&path);
        }
        bail!("http registry bundle unpack is not implemented for non-file URLs in v1")
    }
}

#[derive(Debug, Clone)]
pub struct InstalledSkillV1 {
    pub manifest: SkillManifestV1,
    pub root: PathBuf,
    pub hash: String,
    pub signature_status: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillLockEntryV1 {
    pub slug: String,
    pub version: String,
    pub source: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillsLockV1 {
    pub version: u32,
    pub entries: Vec<SkillLockEntryV1>,
}

#[derive(Debug, Clone)]
pub struct StagedSkillInstall {
    pub manifest: SkillManifestV1,
    pub source: String,
    pub bundle_hash: String,
    pub signature_status: String,
    pub registry_sha256: String,
    pub staging_dir: PathBuf,
    pub target_dir: PathBuf,
    pub lock_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillApprovalPayload {
    pub slug: String,
    pub version: String,
    pub source: String,
    pub scopes: Vec<String>,
    pub allowed_paths: Vec<String>,
    pub allowed_hosts: Vec<String>,
    pub signature_status: String,
    pub hash: String,
    pub staging_dir: PathBuf,
    pub target_dir: PathBuf,
    pub lock_path: PathBuf,
}

pub fn skills_lock_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join("skills.lock")
}

pub fn skills_install_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join("skills")
}

pub fn skills_staging_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".titan/staging/skills")
}

pub fn load_skill_manifest_v1(path: &Path) -> Result<SkillManifestV1> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    toml::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
}

pub fn load_skills_lock_v1(path: &Path) -> Result<SkillsLockV1> {
    if !path.exists() {
        return Ok(SkillsLockV1 {
            version: 1,
            entries: Vec::new(),
        });
    }
    let raw = fs::read_to_string(path)?;
    Ok(toml::from_str(&raw)?)
}

pub fn save_skills_lock_v1(path: &Path, lock: &SkillsLockV1) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, toml::to_string_pretty(lock)?)?;
    Ok(())
}

fn resolve_skill_version(
    index: &RegistryIndexV1,
    slug: &str,
    requested_version: Option<&str>,
) -> Result<ResolvedSkillVersion> {
    let entry = index
        .skills
        .iter()
        .find(|item| item.slug == slug)
        .ok_or_else(|| anyhow!("skill not found in registry: {slug}"))?;
    let version = requested_version.unwrap_or(&entry.latest);
    let v = entry
        .versions
        .iter()
        .find(|item| item.version == version)
        .ok_or_else(|| anyhow!("version not found for {slug}: {version}"))?;
    Ok(ResolvedSkillVersion {
        slug: entry.slug.clone(),
        name: entry.name.clone(),
        version: v.version.clone(),
        download_url: v.download_url.clone(),
        sha256: v.sha256.clone(),
    })
}

pub fn search_registry_v1(
    adapter: &dyn SkillRegistryAdapter,
    query: &str,
) -> Result<Vec<RegistrySkillEntryV1>> {
    let index = adapter.fetch_index()?;
    let needle = query.trim().to_ascii_lowercase();
    let mut out: Vec<RegistrySkillEntryV1> = index
        .skills
        .into_iter()
        .filter(|item| {
            if needle.is_empty() {
                return true;
            }
            let blob = format!("{} {}", item.slug, item.name).to_ascii_lowercase();
            blob.contains(&needle)
        })
        .collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

pub fn inspect_registry_v1(
    adapter: &dyn SkillRegistryAdapter,
    slug: &str,
    version: Option<&str>,
) -> Result<ResolvedSkillVersion> {
    let index = adapter.fetch_index()?;
    resolve_skill_version(&index, slug, version)
}

pub fn stage_install_v1(
    adapter: &dyn SkillRegistryAdapter,
    workspace_root: &Path,
    slug: &str,
    requested_version: Option<&str>,
    force: bool,
) -> Result<StagedSkillInstall> {
    stage_install_v1_with_trust_root(
        adapter,
        workspace_root,
        slug,
        requested_version,
        force,
        &default_trust_root(),
    )
}

pub fn stage_install_v1_with_trust_root(
    adapter: &dyn SkillRegistryAdapter,
    workspace_root: &Path,
    slug: &str,
    requested_version: Option<&str>,
    force: bool,
    trust_root: &Path,
) -> Result<StagedSkillInstall> {
    let index = adapter.fetch_index()?;
    let mut resolved = resolve_skill_version(&index, slug, requested_version)?;
    let lock_path = skills_lock_path(workspace_root);
    let lock = load_skills_lock_v1(&lock_path)?;
    if !force && let Some(existing) = lock.entries.iter().find(|entry| entry.slug == slug) {
        resolved.version = existing.version.clone();
    }
    let resolved = resolve_skill_version(&index, slug, Some(&resolved.version))?;
    let staging_dir =
        skills_staging_root(workspace_root).join(format!("{}-{}", slug, uuid::Uuid::new_v4()));
    let materialized_dir = adapter.fetch_bundle_to_dir(&resolved, &staging_dir)?;
    let bundle_hash = compute_bundle_hash(&materialized_dir)?;
    if bundle_hash != resolved.sha256.to_ascii_lowercase() {
        bail!(
            "sha256 mismatch for {}@{} expected={} got={}",
            resolved.slug,
            resolved.version,
            resolved.sha256,
            bundle_hash
        );
    }
    let manifest_path = materialized_dir.join("skill.toml");
    let skill_md = materialized_dir.join("SKILL.md");
    if !skill_md.exists() {
        bail!("missing required SKILL.md for {}", resolved.slug);
    }
    let manifest = load_skill_manifest_v1(&manifest_path)?;
    let signature_status =
        verify_skill_signature_status_v1(&manifest, &materialized_dir, &bundle_hash, trust_root)?;
    let target_dir = skills_install_root(workspace_root)
        .join(&manifest.slug)
        .join(&manifest.version);
    Ok(StagedSkillInstall {
        manifest,
        source: adapter.id().to_string(),
        bundle_hash,
        signature_status,
        registry_sha256: resolved.sha256,
        staging_dir: materialized_dir,
        target_dir,
        lock_path,
    })
}

pub fn deny_unsigned_risky_install(staged: &StagedSkillInstall) -> Result<()> {
    let unsigned = staged.signature_status != "verified";
    if !unsigned {
        return Ok(());
    }
    let has_exec = staged
        .manifest
        .permissions
        .scopes
        .iter()
        .any(|scope| matches!(scope, SkillScope::Exec));
    if has_exec {
        bail!("unsigned EXEC skills are denied by default");
    }
    let has_net = staged
        .manifest
        .permissions
        .scopes
        .iter()
        .any(|scope| matches!(scope, SkillScope::Net));
    let broad_hosts = staged.manifest.permissions.allowed_hosts.is_empty()
        || staged
            .manifest
            .permissions
            .allowed_hosts
            .iter()
            .any(|host| host == "*");
    if has_net && broad_hosts {
        bail!("unsigned NET skills with wildcard/empty host allowlist are denied by default");
    }
    Ok(())
}

pub fn approval_payload_for_stage(stage: &StagedSkillInstall) -> SkillApprovalPayload {
    SkillApprovalPayload {
        slug: stage.manifest.slug.clone(),
        version: stage.manifest.version.clone(),
        source: stage.source.clone(),
        scopes: stage
            .manifest
            .permissions
            .scopes
            .iter()
            .map(|scope| scope.as_str().to_string())
            .collect(),
        allowed_paths: stage.manifest.permissions.allowed_paths.clone(),
        allowed_hosts: stage.manifest.permissions.allowed_hosts.clone(),
        signature_status: stage.signature_status.clone(),
        hash: stage.bundle_hash.clone(),
        staging_dir: stage.staging_dir.clone(),
        target_dir: stage.target_dir.clone(),
        lock_path: stage.lock_path.clone(),
    }
}

pub fn serialize_approval_payload(payload: &SkillApprovalPayload) -> Result<String> {
    Ok(serde_json::to_string(payload)?)
}

pub fn deserialize_approval_payload(input: &str) -> Result<SkillApprovalPayload> {
    Ok(serde_json::from_str(input)?)
}

pub fn finalize_install_from_payload(payload: &SkillApprovalPayload) -> Result<InstalledSkillV1> {
    let src = canonicalize_existing_dir(&payload.staging_dir)?;
    if payload.target_dir.exists() {
        fs::remove_dir_all(&payload.target_dir)?;
    }
    if let Some(parent) = payload.target_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    copy_dir_recursive(&src, &payload.target_dir)?;
    let manifest = load_skill_manifest_v1(&payload.target_dir.join("skill.toml"))?;
    let mut lock = load_skills_lock_v1(&payload.lock_path)?;
    lock.entries.retain(|entry| entry.slug != payload.slug);
    lock.entries.push(SkillLockEntryV1 {
        slug: payload.slug.clone(),
        version: payload.version.clone(),
        source: payload.source.clone(),
        hash: payload.hash.clone(),
    });
    lock.entries.sort_by(|a, b| a.slug.cmp(&b.slug));
    save_skills_lock_v1(&payload.lock_path, &lock)?;
    Ok(InstalledSkillV1 {
        manifest,
        root: payload.target_dir.clone(),
        hash: payload.hash.clone(),
        signature_status: payload.signature_status.clone(),
        source: payload.source.clone(),
    })
}

pub fn list_installed_skills_v1(workspace_root: &Path) -> Result<Vec<InstalledSkillV1>> {
    let root = skills_install_root(workspace_root);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .min_depth(2)
        .max_depth(3)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("skill.toml");
        if !manifest_path.exists() {
            continue;
        }
        let manifest = load_skill_manifest_v1(&manifest_path)?;
        let hash = compute_bundle_hash(entry.path())?;
        let signature_status = verify_skill_signature_status_v1(
            &manifest,
            entry.path(),
            &hash,
            &default_trust_root(),
        )?;
        out.push(InstalledSkillV1 {
            manifest,
            root: entry.path().to_path_buf(),
            hash,
            signature_status,
            source: "installed".to_string(),
        });
    }
    out.sort_by(|a, b| a.manifest.slug.cmp(&b.manifest.slug));
    Ok(out)
}

pub fn remove_installed_skill_v1(workspace_root: &Path, slug: &str) -> Result<bool> {
    let install_root = skills_install_root(workspace_root).join(slug);
    if !install_root.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&install_root)?;
    let lock_path = skills_lock_path(workspace_root);
    let mut lock = load_skills_lock_v1(&lock_path)?;
    let before = lock.entries.len();
    lock.entries.retain(|entry| entry.slug != slug);
    if lock.entries.len() != before {
        save_skills_lock_v1(&lock_path, &lock)?;
    }
    Ok(true)
}

pub fn verify_skill_signature_status_v1(
    manifest: &SkillManifestV1,
    bundle_dir: &Path,
    _bundle_hash: &str,
    trust_root: &Path,
) -> Result<String> {
    let Some(sig) = &manifest.signature else {
        return Ok("unsigned".to_string());
    };
    let key_path = trust_root.join(format!("{}.pub", sig.public_key_id));
    if !key_path.exists() {
        return Ok("untrusted_key".to_string());
    }
    let pk_bytes =
        fs::read(&key_path).with_context(|| format!("failed reading {}", key_path.display()))?;
    let pk_text = String::from_utf8(pk_bytes).with_context(|| "invalid public key encoding")?;
    let pk_raw = pk_text.trim();
    let pk_decoded = base64::prelude::BASE64_STANDARD
        .decode(pk_raw)
        .with_context(|| "invalid base64 public key")?;
    let public_key = ed25519_dalek::VerifyingKey::from_bytes(
        &pk_decoded
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("invalid key length"))?,
    )
    .with_context(|| "invalid ed25519 public key")?;
    let signature_hash = compute_signature_hash_v1(bundle_dir)?;
    let payload = signature_payload(manifest, &signature_hash)?;
    let sig_bytes = base64::prelude::BASE64_STANDARD
        .decode(sig.ed25519_sig_base64.trim())
        .with_context(|| "invalid base64 signature")?;
    let signature = ed25519_dalek::Signature::from_slice(&sig_bytes)
        .with_context(|| "invalid ed25519 signature bytes")?;
    if public_key
        .verify_strict(payload.as_bytes(), &signature)
        .is_err()
    {
        return Ok("invalid_signature".to_string());
    }
    Ok("verified".to_string())
}

pub fn compute_signature_hash_v1(bundle_dir: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(bundle_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        files.push(entry.path().to_path_buf());
    }
    files.sort();
    for file in files {
        let rel = file
            .strip_prefix(bundle_dir)
            .unwrap_or(&file)
            .to_string_lossy()
            .to_string();
        hasher.update(rel.as_bytes());
        hasher.update([0_u8]);
        if rel == "skill.toml" {
            let mut manifest: SkillManifestV1 = toml::from_str(&fs::read_to_string(&file)?)?;
            manifest.signature = None;
            hasher.update(toml::to_string_pretty(&manifest)?.as_bytes());
        } else {
            hasher.update(fs::read(&file)?);
        }
        hasher.update([0_u8]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn signature_payload(manifest: &SkillManifestV1, bundle_hash: &str) -> Result<String> {
    let mut manifest_json = serde_json::to_value(manifest)?;
    if let Some(obj) = manifest_json.as_object_mut() {
        obj.remove("signature");
    }
    let canonical = canonical_json(&manifest_json);
    Ok(format!("{canonical}{bundle_hash}"))
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(v) => v.to_string(),
        serde_json::Value::Number(v) => v.to_string(),
        serde_json::Value::String(v) => format!("{v:?}"),
        serde_json::Value::Array(items) => {
            let mut out = String::from("[");
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&canonical_json(item));
            }
            out.push(']');
            out
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let mut out = String::from("{");
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&format!("{key:?}:{}", canonical_json(&map[*key])));
            }
            out.push('}');
            out
        }
    }
}

#[derive(Debug, Clone)]
pub enum SkillRunState {
    Completed,
    PendingApproval(String),
}

#[derive(Debug, Clone)]
pub struct SkillRunOutcome {
    pub state: SkillRunState,
    pub goal_id: String,
    pub output: String,
}

pub fn run_skill_v1(
    store: &titan_memory::MemoryStore,
    workspace_root: &Path,
    mode: titan_common::AutonomyMode,
    actor_id: &str,
    slug: &str,
    input: Option<&str>,
) -> Result<SkillRunOutcome> {
    let skill = select_installed_skill(workspace_root, slug)?
        .ok_or_else(|| anyhow!("skill not installed: {slug}"))?;
    let goal = titan_core::Goal::new(format!("skill:{} {}", slug, input.unwrap_or_default()));
    store.create_goal(&goal)?;
    store.add_trace_event(&titan_core::TraceEvent::new(
        goal.id.clone(),
        "skill_run_started",
        format!(
            "slug={} version={}",
            skill.manifest.slug, skill.manifest.version
        ),
    ))?;

    let scopes = &skill.manifest.permissions.scopes;
    for scope in scopes {
        let class = scope.as_capability_class();
        if titan_tools::PolicyEngine::requires_approval(mode.clone(), class) {
            let approval = store.create_approval_request_for_goal(
                Some(goal.id.as_str()),
                "skill_run",
                class.as_str(),
                &format!("slug={} input={}", slug, input.unwrap_or_default()),
                Some(actor_id),
                300_000,
            )?;
            store.add_trace_event(&titan_core::TraceEvent::new(
                goal.id.clone(),
                "skill_run_pending_approval",
                approval.id.clone(),
            ))?;
            return Ok(SkillRunOutcome {
                state: SkillRunState::PendingApproval(approval.id),
                goal_id: goal.id,
                output: "skill run requires approval".to_string(),
            });
        }
    }

    if scopes.iter().any(|scope| matches!(scope, SkillScope::Exec))
        && !store.has_approved_skill_exec_grant(&skill.manifest.slug)?
    {
        let approval = store.create_approval_request_for_goal(
            Some(goal.id.as_str()),
            "skill_exec_grant",
            "exec",
            &skill.manifest.slug,
            Some(actor_id),
            300_000,
        )?;
        store.add_trace_event(&titan_core::TraceEvent::new(
            goal.id.clone(),
            "skill_dangerous_exec_pending",
            approval.id.clone(),
        ))?;
        return Ok(SkillRunOutcome {
            state: SkillRunState::PendingApproval(approval.id),
            goal_id: goal.id,
            output: "skill EXEC run requires dangerous approval".to_string(),
        });
    }

    let (tool_name, tool_input) = resolve_prompt_tool_call(&skill, input)?;
    enforce_allowed_paths(
        &skill.manifest,
        workspace_root,
        &tool_name,
        tool_input.as_deref(),
    )?;
    enforce_allowed_hosts(&skill.manifest, &tool_name, tool_input.as_deref())?;
    let registry = titan_tools::ToolRegistry::with_defaults();
    let tool = registry
        .get(&tool_name)
        .ok_or_else(|| anyhow!("skill references unknown tool: {tool_name}"))?;
    let exec_ctx =
        titan_tools::ToolExecutionContext::default_for_workspace(workspace_root.to_path_buf());
    let result = titan_tools::ToolExecutor::execute(tool, tool_input.as_deref(), &exec_ctx)?;
    store.record_tool_run(None, &tool_name, &result.status, &result.output)?;
    store.update_goal_status(&goal.id, titan_core::GoalStatus::Completed)?;
    store.add_trace_event(&titan_core::TraceEvent::new(
        goal.id.clone(),
        "skill_tool_result",
        format!("tool={} status={}", tool_name, result.status),
    ))?;
    store.add_episodic_memory(
        &goal.id,
        &format!("Skill {} executed via {}", skill.manifest.slug, tool_name),
        "skill",
    )?;
    store.set_skill_last_run_goal(&skill.manifest.slug, &goal.id)?;
    Ok(SkillRunOutcome {
        state: SkillRunState::Completed,
        goal_id: goal.id,
        output: result.output,
    })
}

fn select_installed_skill(workspace_root: &Path, slug: &str) -> Result<Option<InstalledSkillV1>> {
    let mut matches = list_installed_skills_v1(workspace_root)?
        .into_iter()
        .filter(|skill| skill.manifest.slug == slug)
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| a.manifest.version.cmp(&b.manifest.version));
    Ok(matches.pop())
}

fn resolve_prompt_tool_call(
    skill: &InstalledSkillV1,
    input: Option<&str>,
) -> Result<(String, Option<String>)> {
    match skill.manifest.entrypoint_type {
        SkillEntrypointType::Prompt => {
            let entry = skill.manifest.entrypoint.trim();
            if !entry.starts_with("tool:") {
                bail!("prompt entrypoint must use 'tool:<name> [input]'");
            }
            let body = entry.trim_start_matches("tool:").trim();
            let mut parts = body.splitn(2, ' ');
            let name = parts.next().unwrap_or_default().trim();
            if name.is_empty() {
                bail!("prompt entrypoint missing tool name");
            }
            let template = parts
                .next()
                .unwrap_or("")
                .trim()
                .replace("{{input}}", input.unwrap_or(""));
            let arg = if template.trim().is_empty() {
                None
            } else {
                Some(template)
            };
            Ok((name.to_string(), arg))
        }
        SkillEntrypointType::Http => bail!("http entrypoint is not implemented in v1"),
        SkillEntrypointType::Wasm => bail!("wasm entrypoint is not implemented in v1"),
        SkillEntrypointType::ScriptStub => bail!("script_stub entrypoint is not implemented in v1"),
    }
}

fn enforce_allowed_paths(
    manifest: &SkillManifestV1,
    workspace_root: &Path,
    tool_name: &str,
    input: Option<&str>,
) -> Result<()> {
    if !matches!(
        tool_name,
        "read_file" | "write_file" | "list_dir" | "search_text"
    ) {
        return Ok(());
    }
    let requested = extract_requested_path(tool_name, input);
    let Some(path_fragment) = requested else {
        return Ok(());
    };
    if manifest.permissions.allowed_paths.is_empty() {
        return Ok(());
    }
    let root = canonicalize_existing_dir(workspace_root)?;
    let abs = titan_common::path_guard::resolve_existing_path_within(&root, path_fragment)
        .or_else(|_| titan_common::path_guard::resolve_write_path_within(&root, path_fragment))?;
    let mut allowed = false;
    for allowed_path in &manifest.permissions.allowed_paths {
        let normalized = allowed_path.trim().trim_start_matches("./");
        if normalized.is_empty() {
            continue;
        }
        let base = root.join(normalized);
        let prefix = if base.exists() {
            base.canonicalize()?
        } else {
            base
        };
        if abs.starts_with(&prefix) {
            allowed = true;
            break;
        }
    }
    if !allowed {
        bail!(
            "path '{}' is outside allowed_paths for skill",
            path_fragment
        );
    }
    Ok(())
}

fn enforce_allowed_hosts(
    manifest: &SkillManifestV1,
    tool_name: &str,
    input: Option<&str>,
) -> Result<()> {
    if tool_name != "http_get" {
        return Ok(());
    }
    let Some(raw) = input else {
        return Ok(());
    };
    let url = url::Url::parse(raw).with_context(|| "skill http_get input must be URL")?;
    let host = url.host_str().unwrap_or_default();
    if manifest
        .permissions
        .allowed_hosts
        .iter()
        .any(|item| item == "*")
    {
        return Ok(());
    }
    if manifest.permissions.allowed_hosts.is_empty() {
        bail!("NET skill must define allowed_hosts");
    }
    if !manifest
        .permissions
        .allowed_hosts
        .iter()
        .any(|item| item == host)
    {
        bail!("host '{}' is not in allowed_hosts", host);
    }
    Ok(())
}

fn extract_requested_path<'a>(tool_name: &str, input: Option<&'a str>) -> Option<&'a str> {
    let value = input?.trim();
    if value.is_empty() {
        return Some(".");
    }
    match tool_name {
        "write_file" | "search_text" => value.split_once("::").map(|parts| parts.0.trim()),
        _ => Some(value),
    }
}
