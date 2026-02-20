#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/4] format"
cargo fmt --all -- --check

echo "[2/4] clippy"
cargo clippy --workspace --all-targets -- -D warnings

echo "[3/4] tests"
cargo test --workspace

echo "[4/4] smoke commands"
cargo run -q -p titan-cli -- doctor >/dev/null
cargo run -q -p titan-cli -- memory query execution --limit 1 >/dev/null || true

echo "release checks: PASS"
