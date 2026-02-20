use std::fs;

use tempfile::tempdir;
use titan_skills::{SkillPackage, SkillRuntime};

#[test]
fn invalid_wasm_is_rejected() {
    let dir = tempdir().expect("tempdir");
    fs::write(
        dir.path().join("manifest.toml"),
        r#"
name = "bad-skill"
version = "0.1.0"
entrypoint = "bad.wasm"

[capabilities]
filesystem = ["read"]
network = false
environment = []
"#,
    )
    .expect("write manifest");
    fs::write(dir.path().join("bad.wasm"), b"not-wasm").expect("write fake wasm");

    let err = SkillPackage::load(dir.path()).expect_err("invalid wasm should fail");
    assert!(err.to_string().to_lowercase().contains("invalid wasm"));
}

#[test]
fn runtime_rejects_non_directory_workspace() {
    let dir = tempdir().expect("tempdir");
    fs::write(
        dir.path().join("manifest.toml"),
        r#"
name = "tiny-skill"
version = "0.1.0"
entrypoint = "tiny.wasm"

[capabilities]
filesystem = ["read"]
network = false
environment = []
"#,
    )
    .expect("write manifest");
    fs::write(dir.path().join("tiny.wasm"), b"\0asm\x01\0\0\0").expect("write wasm header");

    let pkg = SkillPackage::load(dir.path()).expect("package should load");
    let fake_workspace = dir.path().join("not_a_dir.txt");
    fs::write(&fake_workspace, "x").expect("write file");

    let runtime = SkillRuntime {
        workspace_root: fake_workspace,
        timeout_ms: 1000,
    };
    let err = runtime
        .run(&pkg, &[])
        .expect_err("workspace file should fail");
    assert!(err.to_string().to_lowercase().contains("workspace root"));
}
