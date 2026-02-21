use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use tempfile::{TempDir, tempdir};
use titan_common::AutonomyMode;
use titan_memory::MemoryStore;
use titan_skills::{
    LocalRegistryAdapter, SkillEntrypointType, SkillLockEntryV1, SkillManifestPermissionsV1,
    SkillManifestV1, SkillScope, SkillSignatureV1, SkillsLockV1, approval_payload_for_stage,
    compute_bundle_hash, compute_signature_hash_v1, deny_unsigned_risky_install,
    finalize_install_from_payload, load_skills_lock_v1, run_skill_v1, save_skills_lock_v1,
    serialize_approval_payload, stage_install_v1_with_trust_root,
};

#[test]
fn signed_read_only_install_succeeds_with_approval_record() -> Result<()> {
    let env = TestEnv::new()?;
    let bundle = env.registry_root.join("bundles/list-docs-1.0.0");
    write_skill_bundle(
        &bundle,
        SkillBundleSpec::new("list-docs", "1.0.0", "tool:list_dir docs")
            .scopes(vec![SkillScope::Read])
            .allowed_paths(vec!["docs".to_string()]),
    )?;
    let signature_hash = compute_signature_hash_v1(&bundle)?;
    let signature = sign_manifest(
        &env.signing_key,
        &bundle.join("skill.toml"),
        &signature_hash,
    )?;
    patch_manifest_signature(&bundle.join("skill.toml"), &signature)?;
    let hash = compute_bundle_hash(&bundle)?;
    write_index(
        &env.registry_root.join("index.json"),
        "list-docs",
        "List Docs",
        "1.0.0",
        "bundles/list-docs-1.0.0",
        &hash,
    )?;
    write_trust_key(&env.trust_root, "test-key", &env.signing_key)?;

    let adapter = LocalRegistryAdapter::new(env.registry_root.clone());
    let staged = stage_install_v1_with_trust_root(
        &adapter,
        &env.workspace_root,
        "list-docs",
        None,
        false,
        &env.trust_root,
    )?;
    assert_eq!(staged.signature_status, "verified");
    deny_unsigned_risky_install(&staged)?;

    let store = MemoryStore::open(&env.db_path)?;
    let payload = approval_payload_for_stage(&staged);
    let input = serialize_approval_payload(&payload)?;
    let approval =
        store.create_approval_request("skill_install", "write", &input, Some("test"), 300_000)?;
    assert_eq!(approval.tool_name, "skill_install");
    let installed = finalize_install_from_payload(&payload)?;
    assert_eq!(installed.manifest.slug, "list-docs");
    Ok(())
}

#[test]
fn unsigned_exec_install_is_denied_by_default() -> Result<()> {
    let env = TestEnv::new()?;
    let bundle = env.registry_root.join("bundles/unsafe-exec-1.0.0");
    write_skill_bundle(
        &bundle,
        SkillBundleSpec::new("unsafe-exec", "1.0.0", "tool:run_command echo hi")
            .scopes(vec![SkillScope::Exec])
            .allowed_paths(vec![".".to_string()]),
    )?;
    let hash = compute_bundle_hash(&bundle)?;
    write_index(
        &env.registry_root.join("index.json"),
        "unsafe-exec",
        "Unsafe Exec",
        "1.0.0",
        "bundles/unsafe-exec-1.0.0",
        &hash,
    )?;
    let adapter = LocalRegistryAdapter::new(env.registry_root.clone());
    let staged = stage_install_v1_with_trust_root(
        &adapter,
        &env.workspace_root,
        "unsafe-exec",
        None,
        false,
        &env.trust_root,
    )?;
    let err = deny_unsigned_risky_install(&staged).expect_err("unsigned exec should be denied");
    assert!(err.to_string().contains("unsigned EXEC"));
    Ok(())
}

#[test]
fn unsigned_net_wildcard_install_is_denied_by_default() -> Result<()> {
    let env = TestEnv::new()?;
    let bundle = env.registry_root.join("bundles/open-net-1.0.0");
    write_skill_bundle(
        &bundle,
        SkillBundleSpec::new("open-net", "1.0.0", "tool:http_get https://example.com")
            .scopes(vec![SkillScope::Net])
            .allowed_hosts(vec!["*".to_string()]),
    )?;
    let hash = compute_bundle_hash(&bundle)?;
    write_index(
        &env.registry_root.join("index.json"),
        "open-net",
        "Open Net",
        "1.0.0",
        "bundles/open-net-1.0.0",
        &hash,
    )?;
    let adapter = LocalRegistryAdapter::new(env.registry_root.clone());
    let staged = stage_install_v1_with_trust_root(
        &adapter,
        &env.workspace_root,
        "open-net",
        None,
        false,
        &env.trust_root,
    )?;
    let err = deny_unsigned_risky_install(&staged).expect_err("unsigned wildcard NET denied");
    assert!(err.to_string().contains("wildcard"));
    Ok(())
}

#[test]
fn lockfile_is_enforced_unless_force() -> Result<()> {
    let env = TestEnv::new()?;
    let bundle_v1 = env.registry_root.join("bundles/pkg-1.0.0");
    write_skill_bundle(
        &bundle_v1,
        SkillBundleSpec::new("pkg", "1.0.0", "tool:list_dir .")
            .scopes(vec![SkillScope::Read])
            .allowed_paths(vec![".".to_string()]),
    )?;
    let hash_v1 = compute_bundle_hash(&bundle_v1)?;
    let bundle_v2 = env.registry_root.join("bundles/pkg-2.0.0");
    write_skill_bundle(
        &bundle_v2,
        SkillBundleSpec::new("pkg", "2.0.0", "tool:list_dir .")
            .scopes(vec![SkillScope::Read])
            .allowed_paths(vec![".".to_string()]),
    )?;
    let hash_v2 = compute_bundle_hash(&bundle_v2)?;
    write_multi_index(
        &env.registry_root.join("index.json"),
        "pkg",
        "Pkg",
        "2.0.0",
        &[
            ("1.0.0", "bundles/pkg-1.0.0", hash_v1.as_str()),
            ("2.0.0", "bundles/pkg-2.0.0", hash_v2.as_str()),
        ],
    )?;
    let lock_path = env.workspace_root.join("skills.lock");
    save_skills_lock_v1(
        &lock_path,
        &SkillsLockV1 {
            version: 1,
            entries: vec![SkillLockEntryV1 {
                slug: "pkg".to_string(),
                version: "1.0.0".to_string(),
                source: "local".to_string(),
                hash: hash_v1.clone(),
            }],
        },
    )?;
    let adapter = LocalRegistryAdapter::new(env.registry_root.clone());
    let staged_locked = stage_install_v1_with_trust_root(
        &adapter,
        &env.workspace_root,
        "pkg",
        None,
        false,
        &env.trust_root,
    )?;
    assert_eq!(staged_locked.manifest.version, "1.0.0");
    let staged_force = stage_install_v1_with_trust_root(
        &adapter,
        &env.workspace_root,
        "pkg",
        None,
        true,
        &env.trust_root,
    )?;
    assert_eq!(staged_force.manifest.version, "2.0.0");
    let lock = load_skills_lock_v1(&lock_path)?;
    assert_eq!(lock.entries[0].version, "1.0.0");
    Ok(())
}

#[test]
fn skill_run_is_policy_mediated_and_traced() -> Result<()> {
    let env = TestEnv::new()?;
    fs::create_dir_all(env.workspace_root.join("docs"))?;
    fs::write(env.workspace_root.join("docs/README.md"), "hello")?;
    install_read_skill(&env, "scan", "tool:list_dir docs")?;
    let store = MemoryStore::open(&env.db_path)?;
    let outcome = run_skill_v1(
        &store,
        &env.workspace_root,
        AutonomyMode::Collaborative,
        "tester",
        "scan",
        None,
    )?;
    assert!(matches!(
        outcome.state,
        titan_skills::SkillRunState::Completed
    ));
    let traces = store.get_traces(&outcome.goal_id)?;
    assert!(traces.iter().any(|t| t.event_type == "skill_tool_result"));
    Ok(())
}

#[test]
fn path_outside_allowed_paths_is_blocked() -> Result<()> {
    let env = TestEnv::new()?;
    fs::create_dir_all(env.workspace_root.join("docs"))?;
    fs::write(env.workspace_root.join("secret.txt"), "secret")?;
    install_read_skill(&env, "blocked", "tool:read_file ../secret.txt")?;
    let store = MemoryStore::open(&env.db_path)?;
    let err = run_skill_v1(
        &store,
        &env.workspace_root,
        AutonomyMode::Collaborative,
        "tester",
        "blocked",
        None,
    )
    .expect_err("path guard policy should block");
    let msg = err.to_string();
    assert!(
        msg.contains("outside allowed_paths") || msg.to_ascii_lowercase().contains("workspace")
    );
    Ok(())
}

struct TestEnv {
    _guard: TempDir,
    workspace_root: PathBuf,
    registry_root: PathBuf,
    trust_root: PathBuf,
    db_path: PathBuf,
    signing_key: SigningKey,
}

impl TestEnv {
    fn new() -> Result<Self> {
        let guard = tempdir()?;
        let root = guard.path().to_path_buf();
        let workspace_root = root.join("workspace");
        let registry_root = root.join("registry");
        let trust_root = root.join("trust");
        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&registry_root)?;
        fs::create_dir_all(&trust_root)?;
        let db_path = workspace_root.join("titan.db");
        Ok(Self {
            _guard: guard,
            workspace_root,
            registry_root,
            trust_root,
            db_path,
            signing_key: SigningKey::from_bytes(&[7_u8; 32]),
        })
    }
}

fn install_read_skill(env: &TestEnv, slug: &str, entrypoint: &str) -> Result<()> {
    let install_dir = env.workspace_root.join("skills").join(slug).join("1.0.0");
    write_skill_bundle(
        &install_dir,
        SkillBundleSpec::new(slug, "1.0.0", entrypoint)
            .scopes(vec![SkillScope::Read])
            .allowed_paths(vec!["docs".to_string()]),
    )?;
    let hash = compute_bundle_hash(&install_dir)?;
    let store = MemoryStore::open(&env.db_path)?;
    store.upsert_installed_skill(&titan_memory::InstalledSkillRecord {
        slug: slug.to_string(),
        name: slug.to_string(),
        version: "1.0.0".to_string(),
        description: "test".to_string(),
        source: "test".to_string(),
        hash,
        signature_status: "unsigned".to_string(),
        scopes: "READ".to_string(),
        allowed_paths: "docs".to_string(),
        allowed_hosts: "".to_string(),
        last_run_goal_id: None,
    })?;
    Ok(())
}

#[derive(Clone)]
struct SkillBundleSpec {
    slug: String,
    version: String,
    scopes: Vec<SkillScope>,
    allowed_paths: Vec<String>,
    allowed_hosts: Vec<String>,
    entrypoint: String,
    entrypoint_type: SkillEntrypointType,
    signature: Option<SkillSignatureV1>,
}

impl SkillBundleSpec {
    fn new(slug: &str, version: &str, entrypoint: &str) -> Self {
        Self {
            slug: slug.to_string(),
            version: version.to_string(),
            scopes: vec![SkillScope::Read],
            allowed_paths: Vec::new(),
            allowed_hosts: Vec::new(),
            entrypoint: entrypoint.to_string(),
            entrypoint_type: SkillEntrypointType::Prompt,
            signature: None,
        }
    }

    fn scopes(mut self, scopes: Vec<SkillScope>) -> Self {
        self.scopes = scopes;
        self
    }

    fn allowed_paths(mut self, allowed_paths: Vec<String>) -> Self {
        self.allowed_paths = allowed_paths;
        self
    }

    fn allowed_hosts(mut self, allowed_hosts: Vec<String>) -> Self {
        self.allowed_hosts = allowed_hosts;
        self
    }
}

fn write_skill_bundle(root: &Path, spec: SkillBundleSpec) -> Result<()> {
    fs::create_dir_all(root)?;
    fs::write(root.join("SKILL.md"), "# test skill\n")?;
    let manifest = SkillManifestV1 {
        name: spec.slug.clone(),
        slug: spec.slug.clone(),
        version: spec.version.clone(),
        description: format!("{} desc", spec.slug),
        author: None,
        license: None,
        entrypoint_type: spec.entrypoint_type,
        entrypoint: spec.entrypoint,
        permissions: SkillManifestPermissionsV1 {
            scopes: spec.scopes,
            allowed_paths: spec.allowed_paths,
            allowed_hosts: spec.allowed_hosts,
        },
        signature: spec.signature,
    };
    fs::write(root.join("skill.toml"), toml::to_string_pretty(&manifest)?)?;
    Ok(())
}

fn write_index(
    path: &Path,
    slug: &str,
    name: &str,
    version: &str,
    download_url: &str,
    sha: &str,
) -> Result<()> {
    write_multi_index(path, slug, name, version, &[(version, download_url, sha)])
}

fn write_multi_index(
    path: &Path,
    slug: &str,
    name: &str,
    latest: &str,
    versions: &[(&str, &str, &str)],
) -> Result<()> {
    let versions_json = versions
        .iter()
        .map(|(v, url, sha)| {
            serde_json::json!({
                "version": v,
                "download_url": url,
                "sha256": sha
            })
        })
        .collect::<Vec<_>>();
    let index = serde_json::json!({
        "skills": [{
            "slug": slug,
            "name": name,
            "latest": latest,
            "versions": versions_json
        }]
    });
    fs::write(path, serde_json::to_vec_pretty(&index)?)?;
    Ok(())
}

fn sign_manifest(
    signing_key: &SigningKey,
    manifest_path: &Path,
    hash: &str,
) -> Result<SkillSignatureV1> {
    let manifest: SkillManifestV1 = toml::from_str(&fs::read_to_string(manifest_path)?)?;
    let mut value = serde_json::to_value(&manifest)?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("signature");
    }
    let canonical = canonical_json_local(&value);
    let payload = format!("{canonical}{hash}");
    let sig = signing_key.sign(payload.as_bytes());
    Ok(SkillSignatureV1 {
        public_key_id: "test-key".to_string(),
        ed25519_sig_base64: base64::prelude::BASE64_STANDARD.encode(sig.to_bytes()),
    })
}

fn canonical_json_local(value: &serde_json::Value) -> String {
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
                out.push_str(&canonical_json_local(item));
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
                out.push_str(&format!("{key:?}:{}", canonical_json_local(&map[*key])));
            }
            out.push('}');
            out
        }
    }
}

fn patch_manifest_signature(path: &Path, signature: &SkillSignatureV1) -> Result<()> {
    let mut manifest: SkillManifestV1 = toml::from_str(&fs::read_to_string(path)?)?;
    manifest.signature = Some(signature.clone());
    fs::write(path, toml::to_string_pretty(&manifest)?)?;
    Ok(())
}

fn write_trust_key(root: &Path, key_id: &str, signing_key: &SigningKey) -> Result<()> {
    fs::create_dir_all(root)?;
    let public = signing_key.verifying_key();
    fs::write(
        root.join(format!("{key_id}.pub")),
        base64::prelude::BASE64_STANDARD.encode(public.to_bytes()),
    )?;
    Ok(())
}
