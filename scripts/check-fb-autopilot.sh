#!/bin/bash
# Quick health check for FB autopilot on Titan PC
# Usage: ./scripts/check-fb-autopilot.sh

set -euo pipefail

echo "═══════════════════════════════════════"
echo "  TITAN FB Autopilot Health Check"
echo "═══════════════════════════════════════"
echo ""

# Service status
echo "─── Service ───"
ssh "${TITAN_HOST}" "systemctl is-active titan.service"
echo ""

# Get session token
# Never hardcode the gateway password (v8.0.0 release sweep).
PASSWORD="${TITAN_GATEWAY_PASSWORD:?set TITAN_GATEWAY_PASSWORD in your environment}"
SESSION=$(ssh "${TITAN_HOST}" "curl -sk -X POST https://localhost:48420/api/login -H 'Content-Type: application/json' --data-raw '{\"password\":\"$PASSWORD\"}'" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

# Health
echo "─── Gateway Health ───"
ssh "${TITAN_HOST}" "curl -sk https://localhost:48420/api/health -H 'Authorization: Bearer $SESSION'" | python3 -m json.tool
echo ""

# Recent FB autopilot activity
echo "─── Recent FB Autopilot activity (last 20 events) ───"
ssh "${TITAN_HOST}" "grep -E 'FBAutopilot|OutboundSanitizer' ~/titan.log | tail -20"
echo ""

# Sanitizer blocks (if any)
echo "─── Sanitizer blocks ever ───"
BLOCK_COUNT=$(ssh "${TITAN_HOST}" "grep -c 'OutboundSanitizer.*Content blocked' ~/titan.log 2>/dev/null || echo 0")
echo "Total content blocks: $BLOCK_COUNT"
echo ""

# Errors
echo "─── Errors in last hour ───"
ssh "${TITAN_HOST}" "grep ERROR ~/titan.log | tail -5"
echo ""

echo "═══════════════════════════════════════"
echo "  Done"
echo "═══════════════════════════════════════"
