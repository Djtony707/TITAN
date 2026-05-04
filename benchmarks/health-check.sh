#!/bin/bash
# TITAN Health Check Script
# Safe, read-only diagnostic script.
# Usage: ./benchmarks/health-check.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$REPO_ROOT/benchmarks/results"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
RESULT_FILE="$RESULTS_DIR/$TIMESTAMP.json"

mkdir -p "$RESULTS_DIR"

echo "🧠 KIMI-COO TITAN Health Check"
echo "=============================="
echo "Date: $(date)"
echo "Machine: $(hostname)"
echo "User: $(whoami)"
echo "Repo: $REPO_ROOT"
echo ""

# Initialize JSON result
cat > "$RESULT_FILE" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "hostname": "$(hostname)",
  "user": "$(whoami)",
  "checks": {}
}
EOF

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  echo "🔍 $name"
  if eval "$cmd" > /dev/null 2>&1; then
    echo "  ✅ PASS"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL"
    FAIL=$((FAIL + 1))
  fi
}

check "Node.js >= 22" "node -e 'process.exit(process.version.slice(1).split(\".\")[0] >= 22 ? 0 : 1)'"
check "npm available" "npm -v"
check "node_modules exists" "test -d $REPO_ROOT/node_modules"
check "Repo is git repo" "test -d $REPO_ROOT/.git"
check "Repo has origin remote" "cd $REPO_ROOT && git remote get-url origin > /dev/null"
check "package.json exists" "test -f $REPO_ROOT/package.json"
check "README.md exists" "test -f $REPO_ROOT/README.md"
check "vitest config exists" "test -f $REPO_ROOT/vitest.config.ts"

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed"
echo "Saved to: $RESULT_FILE"
echo "=============================="

exit $FAIL
