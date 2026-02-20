# Release Checklist

Use this checklist before tagging a public release.

## 1) Quality Gates

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

## 2) Smoke Validation (Ubuntu Path)

```bash
./scripts/smoke_ubuntu.sh
```

Expected:
- release build succeeds
- `titan doctor` succeeds
- `titan run` startup log is printed
- Web UI bind is shown (`http://127.0.0.1:3000`)

## 3) Copy-Risk Check

```bash
./scripts/copy-risk-check.sh
```

Confirm output contains attribution-only references where required.

## 4) Git Cleanliness

```bash
git status --short
```

Expected before release commit/tag:
- no unintended files
- no secret/config artifacts (`.env`, `.titan`, local DBs)
- clean working tree after commit
