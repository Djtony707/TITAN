#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[copy-risk] scanning for third-party attribution markers"
rg -n "Modified from|modified from|third-party|THIRD_PARTY_NOTICES" -S . \
  -g '!target' \
  -g '!.git' \
  -g '!**/*.lock' || true

echo
if [[ ! -f THIRD_PARTY_NOTICES.md ]]; then
  echo "[copy-risk] ERROR: THIRD_PARTY_NOTICES.md missing"
  exit 1
fi

echo "[copy-risk] THIRD_PARTY_NOTICES.md present"
echo "[copy-risk] done"
