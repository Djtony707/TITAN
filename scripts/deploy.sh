#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# TITAN Deploy Script
# Deploys TITAN to the Titan PC (ssh alias: titan, at /opt/TITAN/)
#
# Usage:
#   ./scripts/deploy.sh [flags]
#
# Flags:
#   --ui          Force rebuild the UI (otherwise only rebuilds if ui/src changed)
#   --deps        Also sync node_modules/ to remote (slow)
#   --no-restart  Deploy files without restarting the service
#   --dry-run     Show what would be deployed without doing anything
#
# Examples:
#   ./scripts/deploy.sh                # Standard deploy
#   ./scripts/deploy.sh --ui --deps    # Full deploy with UI rebuild and deps
#   ./scripts/deploy.sh --dry-run      # Preview what would happen
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Resolve project root from script location ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Remote config ──────────────────────────────────────────────────
REMOTE="titan"
REMOTE_PATH="/opt/TITAN"
SERVICE_NAME="titan"
LOG_FILE="/home/dj/titan.log"

# ── Parse flags ────────────────────────────────────────────────────
FORCE_UI=false
SYNC_DEPS=false
NO_RESTART=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --ui)         FORCE_UI=true ;;
    --deps)       SYNC_DEPS=true ;;
    --no-restart) NO_RESTART=true ;;
    --dry-run)    DRY_RUN=true ;;
    *)
      echo "Unknown flag: $arg"
      echo "Usage: deploy.sh [--ui] [--deps] [--no-restart] [--dry-run]"
      exit 1
      ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────
DEPLOYED_COMPONENTS=()

info()  { echo "  ▸ $*"; }
step()  { echo ""; echo "── $* ──"; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*" >&2; }

# Check if ui/src has changed since last deploy marker
ui_needs_rebuild() {
  local marker="$PROJECT_DIR/.last-ui-deploy"
  if [[ ! -f "$marker" ]]; then
    return 0  # No marker = never deployed, rebuild
  fi
  # Check if any ui/src file is newer than the marker
  if find "$PROJECT_DIR/ui/src" -newer "$marker" -print -quit 2>/dev/null | grep -q .; then
    return 0  # Files changed
  fi
  return 1  # No changes
}

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║        TITAN Deploy → Titan PC        ║"
echo "╚═══════════════════════════════════════╝"

if $DRY_RUN; then
  echo ""
  echo "  *** DRY RUN — no changes will be made ***"
fi

# ── Step 1: Build TypeScript ───────────────────────────────────────
step "1. Build TypeScript"
if $DRY_RUN; then
  info "Would run: npm run build"
else
  npm run build 2>&1 | tail -5
  ok "TypeScript compiled → dist/"
fi
DEPLOYED_COMPONENTS+=("dist/")

# ── Step 2: Build UI (conditional) ─────────────────────────────────
step "2. Build UI"
BUILD_UI=false
if $FORCE_UI; then
  info "Forced via --ui flag"
  BUILD_UI=true
elif ui_needs_rebuild; then
  info "ui/src files changed since last deploy"
  BUILD_UI=true
else
  info "ui/src unchanged — skipping rebuild"
fi

if $BUILD_UI; then
  if $DRY_RUN; then
    info "Would run: npm run build:ui"
  else
    npm run build:ui 2>&1 | tail -5
    touch "$PROJECT_DIR/.last-ui-deploy"
    ok "UI compiled → ui/dist/"
  fi
  DEPLOYED_COMPONENTS+=("ui/dist/")
fi

# ── Step 3: Rsync to Titan PC ─────────────────────────────────────
step "3. Sync files to $REMOTE:$REMOTE_PATH"

RSYNC_BASE="rsync -avz --delete"

# dist/
info "dist/ → remote"
if $DRY_RUN; then
  $RSYNC_BASE --dry-run "$PROJECT_DIR/dist/" "$REMOTE:$REMOTE_PATH/dist/" 2>&1 | tail -3
else
  $RSYNC_BASE "$PROJECT_DIR/dist/" "$REMOTE:$REMOTE_PATH/dist/" 2>&1 | tail -3
fi

# ui/dist/
info "ui/dist/ → remote"
if $DRY_RUN; then
  $RSYNC_BASE --dry-run "$PROJECT_DIR/ui/dist/" "$REMOTE:$REMOTE_PATH/ui/dist/" 2>&1 | tail -3
else
  $RSYNC_BASE "$PROJECT_DIR/ui/dist/" "$REMOTE:$REMOTE_PATH/ui/dist/" 2>&1 | tail -3
fi

# assets/
info "assets/ → remote"
if $DRY_RUN; then
  $RSYNC_BASE --dry-run "$PROJECT_DIR/assets/" "$REMOTE:$REMOTE_PATH/assets/" 2>&1 | tail -3
else
  $RSYNC_BASE "$PROJECT_DIR/assets/" "$REMOTE:$REMOTE_PATH/assets/" 2>&1 | tail -3
fi
DEPLOYED_COMPONENTS+=("assets/")

# package.json
info "package.json → remote"
if $DRY_RUN; then
  info "Would copy package.json"
else
  rsync -avz "$PROJECT_DIR/package.json" "$REMOTE:$REMOTE_PATH/package.json" 2>&1 | tail -2
fi
DEPLOYED_COMPONENTS+=("package.json")

# node_modules/ (only with --deps)
if $SYNC_DEPS; then
  info "node_modules/ → remote (this may take a while...)"
  if $DRY_RUN; then
    info "Would sync node_modules/"
  else
    $RSYNC_BASE "$PROJECT_DIR/node_modules/" "$REMOTE:$REMOTE_PATH/node_modules/" 2>&1 | tail -3
  fi
  DEPLOYED_COMPONENTS+=("node_modules/")
else
  info "node_modules/ — skipped (use --deps to include)"
fi

# ── Step 4: Restart service ────────────────────────────────────────
step "4. Restart service"
if $NO_RESTART; then
  info "Skipped (--no-restart flag)"
elif $DRY_RUN; then
  info "Would run: ssh $REMOTE \"sudo systemctl restart $SERVICE_NAME\""
else
  info "Restarting $SERVICE_NAME..."
  ssh "$REMOTE" "sudo systemctl restart $SERVICE_NAME"
  ok "Service restarted"

  # ── Step 5: Verify service is running ────────────────────────────
  step "5. Verify service"
  info "Waiting 5 seconds for startup..."
  sleep 5

  SERVICE_STATUS=$(ssh "$REMOTE" "systemctl is-active $SERVICE_NAME" 2>/dev/null || true)
  if [[ "$SERVICE_STATUS" == "active" ]]; then
    ok "Service is active"
  else
    fail "Service status: $SERVICE_STATUS"
    info "Checking logs for errors..."
    ssh "$REMOTE" "tail -20 $LOG_FILE" 2>/dev/null || true
    exit 1
  fi

  # ── Step 6: Show recent logs ─────────────────────────────────────
  step "6. Recent logs"
  ssh "$REMOTE" "tail -10 $LOG_FILE" 2>/dev/null || info "Could not read $LOG_FILE"
fi

# ── Step 7: Verify key files on remote ─────────────────────────────
step "7. Verify remote files"
VERIFY_FILES=(
  "dist/cli/index.js"
  "ui/dist/index.html"
  "assets/personas/"
)

VERIFY_OK=true
for f in "${VERIFY_FILES[@]}"; do
  if $DRY_RUN; then
    info "Would verify: $REMOTE_PATH/$f"
  else
    if ssh "$REMOTE" "test -e $REMOTE_PATH/$f" 2>/dev/null; then
      ok "$f exists"
    else
      fail "$f MISSING"
      VERIFY_OK=false
    fi
  fi
done

if ! $DRY_RUN && ! $VERIFY_OK; then
  fail "Some files are missing on remote — deploy may be incomplete"
  exit 1
fi

# ── Summary ────────────────────────────────────────────────────────
echo ""
echo "╔═══════════════════════════════════════╗"
echo "║          Deploy Summary               ║"
echo "╠═══════════════════════════════════════╣"

if $DRY_RUN; then
  echo "║  Mode:    DRY RUN (nothing deployed)  ║"
else
  echo "║  Status:  ${SERVICE_STATUS:-not restarted}$(printf '%*s' $((24 - ${#SERVICE_STATUS:-14})) '')║"
fi

echo "║                                       ║"
echo "║  Synced:                               ║"

for comp in "${DEPLOYED_COMPONENTS[@]}"; do
  printf "║    • %-33s║\n" "$comp"
done

if $SYNC_DEPS; then
  printf "║    • %-33s║\n" "node_modules/ (full)"
fi

echo "║                                       ║"
echo "║  Dashboard: http://192.168.1.11:48420  ║"
echo "╚═══════════════════════════════════════╝"
echo ""
