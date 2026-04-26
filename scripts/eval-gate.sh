#!/usr/bin/env bash
#
# eval-gate.sh — Run TITAN eval suites locally and gate on per-suite pass rate.
#
# Usage:
#   ./scripts/eval-gate.sh                   # default 80% threshold
#   ./scripts/eval-gate.sh --threshold 90    # tighter gate
#   ./scripts/eval-gate.sh --suite safety    # run a single suite
#   ./scripts/eval-gate.sh --gateway-url https://my.titan:48420
#
# Behaviour:
#   - If TITAN gateway is already healthy on $GATEWAY_URL, reuse it.
#   - Otherwise boot one in the background, run the suites, kill it on exit.
#   - For each suite: POST /api/eval/run, parse passed/total/durationMs,
#     compute pass rate as a percentage, fail if below threshold.
#   - Print a summary table at the end.
#   - Exit code: 0 = all suites ≥ threshold, 1 = any failure or boot error.
#
# Same logic as .github/workflows/eval-gate.yml so CI and local results match.
# Designed to be safe to run from a Husky pre-push hook.

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────
THRESHOLD=80
GATEWAY_URL="${GATEWAY_URL:-http://localhost:48420}"
SUITES_FILTER=""
RESULTS_DIR="${RESULTS_DIR:-$(mktemp -d)}"
BOOT_PID=""
BOOT_LOG=""

# All eval suites from src/eval/harness.ts. Keep in sync if more land.
ALL_SUITES=(
  widget-creation
  safety
  tool-routing
  gate-format
  pipeline
  adversarial
  tool-routing-v2
  session
  widget-v2
  gate-format-v2
  content
)

# ── Arg parsing ──────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --gateway-url) GATEWAY_URL="$2"; shift 2 ;;
    --suite) SUITES_FILTER="$2"; shift 2 ;;
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^#$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────
log()  { printf '%s\n' "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

cleanup() {
  if [ -n "$BOOT_PID" ] && kill -0 "$BOOT_PID" 2>/dev/null; then
    log "Stopping gateway (pid $BOOT_PID)"
    kill "$BOOT_PID" 2>/dev/null || true
    wait "$BOOT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

is_healthy() {
  # 2 second timeout — health checks should be near-instant. -k for
  # self-signed HTTPS (Titan PC's gateway uses cert.pem/key.pem).
  curl -sk --max-time 2 "$GATEWAY_URL/api/health" \
    | grep -q '"status":"ok"' 2>/dev/null
}

boot_gateway() {
  log "Booting gateway in background (logs → $BOOT_LOG)..."
  BOOT_LOG="$(mktemp)"
  if [ ! -f dist/gateway/server.js ]; then
    log "dist/gateway/server.js missing — running npm run build first"
    npm run build > "$BOOT_LOG" 2>&1 || die "build failed"
  fi
  node dist/gateway/server.js > "$BOOT_LOG" 2>&1 &
  BOOT_PID=$!
  for i in $(seq 1 60); do
    if is_healthy; then
      log "Gateway ready after ${i}s (pid $BOOT_PID)"
      return 0
    fi
    sleep 1
  done
  log "Gateway did not become healthy within 60s. Last 50 lines of log:"
  tail -n 50 "$BOOT_LOG" >&2
  die "gateway boot failed"
}

# ── Pre-flight ───────────────────────────────────────────────────────
command -v jq  >/dev/null 2>&1 || die "jq is required (brew install jq / apt install jq)"
command -v awk >/dev/null 2>&1 || die "awk is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

mkdir -p "$RESULTS_DIR"

if is_healthy; then
  log "Reusing already-running gateway at $GATEWAY_URL"
else
  boot_gateway
fi

# ── Determine which suites to run ────────────────────────────────────
if [ -n "$SUITES_FILTER" ]; then
  SUITES=("$SUITES_FILTER")
else
  SUITES=("${ALL_SUITES[@]}")
fi

# ── Run suites ───────────────────────────────────────────────────────
declare -a TABLE_ROWS=()
TABLE_ROWS+=("$(printf '%-20s %8s %8s %6s %s' SUITE PASSED TOTAL RATE STATUS)")
TABLE_ROWS+=("$(printf '%-20s %8s %8s %6s %s' '------' '------' '-----' '----' '------')")

OVERALL_PASSED=0
OVERALL_TOTAL=0
FAILED_SUITES=()

for suite in "${SUITES[@]}"; do
  log ""
  log "── Running suite: $suite ──"
  out_file="$RESULTS_DIR/${suite}.json"
  http_code=$(curl -sk -o "$out_file" -w '%{http_code}' \
    --max-time 600 \
    -X POST "$GATEWAY_URL/api/eval/run" \
    -H 'Content-Type: application/json' \
    -d "{\"suite\":\"$suite\"}")

  if [ "$http_code" != "200" ]; then
    log "  HTTP $http_code on $suite — flagging as failure"
    TABLE_ROWS+=("$(printf '%-20s %8s %8s %6s %s' "$suite" - - - "HTTP $http_code")")
    FAILED_SUITES+=("$suite")
    continue
  fi

  passed=$(jq '.passed // 0' "$out_file")
  total=$(jq '.total // 0' "$out_file")
  duration_ms=$(jq '.durationMs // 0' "$out_file")
  if [ "$total" -eq 0 ]; then
    log "  $suite returned 0 cases (gateway has no cases registered for this suite name)"
    TABLE_ROWS+=("$(printf '%-20s %8s %8s %6s %s' "$suite" 0 0 - 'EMPTY')")
    continue
  fi
  rate=$(awk "BEGIN {printf \"%.0f\", ($passed/$total)*100}")
  dur_s=$(awk "BEGIN {printf \"%.1fs\", $duration_ms/1000}")

  if [ "$rate" -lt "$THRESHOLD" ]; then
    status="FAIL ($dur_s)"
    FAILED_SUITES+=("$suite")
  else
    status="PASS ($dur_s)"
  fi
  TABLE_ROWS+=("$(printf '%-20s %8d %8d %5d%% %s' "$suite" "$passed" "$total" "$rate" "$status")")
  OVERALL_PASSED=$((OVERALL_PASSED + passed))
  OVERALL_TOTAL=$((OVERALL_TOTAL + total))
done

# ── Summary ──────────────────────────────────────────────────────────
log ""
log "── Eval gate summary (threshold ${THRESHOLD}%) ──"
for row in "${TABLE_ROWS[@]}"; do log "$row"; done
log ""
if [ "$OVERALL_TOTAL" -gt 0 ]; then
  overall_rate=$(awk "BEGIN {printf \"%.0f\", ($OVERALL_PASSED/$OVERALL_TOTAL)*100}")
  log "Overall: $OVERALL_PASSED/$OVERALL_TOTAL (${overall_rate}%)"
fi
log "Results JSON: $RESULTS_DIR"

if [ "${#FAILED_SUITES[@]}" -gt 0 ]; then
  log ""
  log "FAILED SUITES: ${FAILED_SUITES[*]}"
  exit 1
fi
log ""
log "All suites passed."
exit 0
