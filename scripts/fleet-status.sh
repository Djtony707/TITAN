#!/bin/bash
# Check status of all homelab machines and services
# Usage: ./scripts/fleet-status.sh [machine]

set -uo pipefail

check_machine() {
  local name="$1" host="$2" user="$3"

  echo "━━━ $name ($host) ━━━"

  if ! ssh -o ConnectTimeout=3 "$user@$host" "echo ok" &>/dev/null; then
    echo "  ❌ OFFLINE"
    echo ""
    return
  fi

  echo "  ✅ Online"

  # Docker containers
  local containers
  containers=$(ssh "$user@$host" "docker ps --format '  📦 {{.Names}}: {{.Status}} ({{.Ports}})' 2>/dev/null" || echo "")
  if [ -n "$containers" ]; then
    echo "$containers"
  fi

  # GPU check
  if [ "$name" = "Titan PC" ]; then
    local gpu
    gpu=$(ssh "$user@$host" "nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null" || echo "")
    [ -n "$gpu" ] && echo "  🎮 GPU: $gpu"
  fi

  # TITAN health
  local health
  health=$(ssh "$user@$host" "curl -s --max-time 2 http://localhost:48420/api/health 2>/dev/null" || echo "")
  if [ -n "$health" ]; then
    echo "  🌐 TITAN Gateway: UP"
  fi

  # Disk & RAM
  local disk mem
  disk=$(ssh "$user@$host" "df -h / | tail -1 | awk '{print \$4 \" free / \" \$2}'" 2>/dev/null || echo "?")
  mem=$(ssh "$user@$host" "free -h | awk '/Mem:/{print \$3 \" / \" \$2}'" 2>/dev/null || echo "?")
  echo "  💾 Disk: $disk | RAM: $mem"
  echo ""
}

echo "🖥️  AI Homelab Fleet — $(date '+%Y-%m-%d %H:%M')"
echo ""

TARGET="${1:-all}"

declare -a MACHINES=(
  "Titan PC|<titan-host>|dj"
  "Mini PC|<minipc-host>|djtony707"
  "T610|<t610-host>|t610"
)

for m in "${MACHINES[@]}"; do
  IFS='|' read -r name host user <<< "$m"
  if [ "$TARGET" = "all" ] || [[ "${name,,}" == *"${TARGET,,}"* ]]; then
    check_machine "$name" "$host" "$user"
  fi
done
