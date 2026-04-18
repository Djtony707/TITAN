#!/bin/bash
# TITAN — Soft Goal Reset (v4.9.0+)
#
# Archives goals.json, command-post.json approvals, + activity feed
# to ~/.titan/archive-<ts>/, then clears the active lists. Keeps
# identity, graph, learning, drive-state — TITAN's self intact, just
# with a clean task slate.
#
# Use when accumulated self-proposed goals from before the memory
# architecture are crowding out new work. Not destructive — the
# archive is preserved for audit.

set -euo pipefail

REMOTE="${1:-titan}"
TITAN_HOME="${TITAN_HOME:-/home/dj/.titan}"
TS=$(date +%Y%m%dT%H%M%S)
ARCHIVE_DIR="${TITAN_HOME}/archive-${TS}"

echo "── TITAN Goal Reset (soft) ──"
echo "  Target:       ${REMOTE}"
echo "  TITAN_HOME:   ${TITAN_HOME}"
echo "  Archive to:   ${ARCHIVE_DIR}"
echo

read -p "Proceed? (yes/no) " -r
if [[ ! "$REPLY" =~ ^yes$ ]]; then
  echo "Aborted."
  exit 1
fi

ssh "${REMOTE}" bash <<EOF
set -e
cd "${TITAN_HOME}"
mkdir -p "${ARCHIVE_DIR}"

# Archive
[ -f goals.json ] && cp goals.json "${ARCHIVE_DIR}/goals.json"
[ -f command-post.json ] && cp command-post.json "${ARCHIVE_DIR}/command-post.json"
[ -f command-post-activity.jsonl ] && cp command-post-activity.jsonl "${ARCHIVE_DIR}/command-post-activity.jsonl"
[ -f goal-proposer-state.json ] && cp goal-proposer-state.json "${ARCHIVE_DIR}/goal-proposer-state.json"
[ -f initiative-state.json ] && cp initiative-state.json "${ARCHIVE_DIR}/initiative-state.json"

# Reset goals to empty list (keep schema)
python3 -c "
import json, sys
try:
    d = json.load(open('goals.json'))
    d['goals'] = []
    d['lastUpdated'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
    open('goals.json', 'w').write(json.dumps(d, indent=2))
except Exception as e:
    print(f'goals.json reset skipped: {e}', file=sys.stderr)
"

# Reset command-post activity + pending approvals (keep agents registry)
python3 -c "
import json, sys
try:
    d = json.load(open('command-post.json'))
    # Clear pending approvals only — keep registered agents
    d['approvals'] = [a for a in d.get('approvals', []) if a.get('status') != 'pending']
    open('command-post.json', 'w').write(json.dumps(d, indent=2))
except Exception as e:
    print(f'command-post.json reset skipped: {e}', file=sys.stderr)
"

# Truncate activity + proposer state
: > command-post-activity.jsonl
[ -f goal-proposer-state.json ] && echo '{}' > goal-proposer-state.json
[ -f initiative-state.json ] && echo '{}' > initiative-state.json

echo "Archive: ${ARCHIVE_DIR}"
ls -la "${ARCHIVE_DIR}"
EOF

echo
echo "Restarting titan service so new state takes effect..."
ssh "${REMOTE}" "sudo systemctl restart titan"
sleep 5
echo "Done. Check logs:"
ssh "${REMOTE}" "tail -15 /home/dj/titan.log"
