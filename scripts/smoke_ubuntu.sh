#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
EXAMPLE_REPO_PATH="/home/$USER/Desktop/TITAN"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[smoke] missing required command: $1" >&2
    exit 1
  fi
}

run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${secs}" "$@"
    return
  fi
  "$@" &
  local pid=$!
  sleep "${secs}"
  kill "${pid}" >/dev/null 2>&1 || true
  wait "${pid}" >/dev/null 2>&1 || true
}

echo "[smoke] repo example path: ${EXAMPLE_REPO_PATH}"
need_cmd cargo
need_cmd rustc

RUSTC_VER="$(rustc --version)"
CARGO_VER="$(cargo --version)"
echo "[smoke] rustc: ${RUSTC_VER}"
echo "[smoke] cargo: ${CARGO_VER}"

echo "[smoke] building release binary"
cargo build --release

SMOKE_CFG_DIR="$(mktemp -d)"
SMOKE_CFG="${SMOKE_CFG_DIR}/config.toml"
export TITAN_CONFIG="${SMOKE_CFG}"

echo "[smoke] running doctor with isolated TITAN_CONFIG=<temp-config>"
./target/release/titan doctor | sed -E 's#/Users/[^[:space:]]+#/home/$USER#g'

echo "[smoke] starting titan run for local startup validation (8s)"
RUN_LOG="${SMOKE_CFG_DIR}/run.log"
set +e
run_with_timeout 8s ./target/release/titan run --bind 127.0.0.1:3000 >"${RUN_LOG}" 2>&1
RUN_EXIT=$?
set -e
if [[ ${RUN_EXIT} -ne 0 && ${RUN_EXIT} -ne 124 ]]; then
  echo "[smoke] titan run exited with code ${RUN_EXIT}" >&2
  cat "${RUN_LOG}" >&2
  exit ${RUN_EXIT}
fi

echo "[smoke] titan run startup log"
cat "${RUN_LOG}" | sed -E 's#/Users/[^[:space:]]+#/home/$USER#g'

echo
echo "[smoke] next steps for full Discord E2E"
echo "0) cd /home/\$USER/Desktop/TITAN"
echo "1) export DISCORD_BOT_TOKEN='<bot-token>'    # DISCORD_TOKEN alias also supported"
echo "2) export DISCORD_CHANNEL_ID='<channel-id>'     # optional override if not set in onboarding"
echo "3) titan onboard --yes                           # auto-apply defaults from env"
echo "   (or run: titan onboard for full interactive wizard)"
echo "4) titan run --bind 127.0.0.1:3000"
echo "5) In Discord send: 'scan workspace'"
echo "6) Open Web UI: http://127.0.0.1:3000"
echo "7) Send: 'update readme with install steps'"
echo "8) Approve via: /titan approve <approval_id>"

echo "[smoke] completed"
