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
ssh titan "systemctl is-active titan.service"
echo ""

# Get session token
PASSWORD='06052021Aell!'
SESSION=$(ssh titan "curl -sk -X POST https://localhost:48420/api/login -H 'Content-Type: application/json' --data-raw '{\"password\":\"$PASSWORD\"}'" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

# Health
echo "─── Gateway Health ───"
ssh titan "curl -sk https://localhost:48420/api/health -H 'Authorization: Bearer $SESSION'" | python3 -m json.tool
echo ""

# Recent FB autopilot activity
echo "─── Recent FB Autopilot activity (last 20 events) ───"
ssh titan "grep -E 'FBAutopilot|OutboundSanitizer' /home/dj/titan.log | tail -20"
echo ""

# Sanitizer blocks (if any)
echo "─── Sanitizer blocks ever ───"
BLOCK_COUNT=$(ssh titan "grep -c 'OutboundSanitizer.*Content blocked' /home/dj/titan.log 2>/dev/null || echo 0")
echo "Total content blocks: $BLOCK_COUNT"
echo ""

# Errors
echo "─── Errors in last hour ───"
ssh titan "grep ERROR /home/dj/titan.log | tail -5"
echo ""

echo "═══════════════════════════════════════"
echo "  Done"
echo "═══════════════════════════════════════"
