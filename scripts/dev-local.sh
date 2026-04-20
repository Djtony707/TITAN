#!/usr/bin/env bash
set -euo pipefail

# Navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Environment ---
export OLLAMA_BASE_URL="http://192.168.1.11:11434"
export TITAN_GATEWAY_PORT=48421
export TITAN_GATEWAY_HOST="127.0.0.1"
export TITAN_LOG_LEVEL="debug"

# Load local credentials if available
if [ -f ".env.local" ]; then
  # shellcheck disable=SC1091
  source .env.local
  echo "Loaded .env.local"
else
  echo "No .env.local found — skipping credential loading"
fi

# --- Banner ---
echo ""
echo "============================================="
echo "        TITAN LOCAL DEV MODE"
echo "============================================="
echo ""
echo "  Ollama URL:   $OLLAMA_BASE_URL"
echo "  Gateway URL:  http://localhost:$TITAN_GATEWAY_PORT"
echo ""
echo "  WARNING: This is LOCAL testing"
echo "  Production is at 192.168.1.11:48420"
echo ""
echo "============================================="
echo ""

# --- Run ---
exec npx tsx src/cli/index.ts gateway --skip-usable-check
