#!/usr/bin/env bash
# Audit every maintained JavaScript dependency surface. Advisory-service errors and missing
# lockfiles fail the command, just like a reported advisory. No severities are excluded.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failed=0

for project in . ui examples/mcp-server; do
  printf '\nAuditing npm project: %s\n' "$project"
  if [[ ! -f "$repo_root/$project/package-lock.json" ]]; then
    printf 'Missing package-lock.json: %s\n' "$project" >&2
    failed=1
    continue
  fi
  (cd "$repo_root/$project" && npm audit --package-lock-only --audit-level=low) || failed=1
done

printf '\nAuditing pnpm project: titan-voice-ui\n'
if [[ ! -f "$repo_root/titan-voice-ui/pnpm-lock.yaml" ]]; then
  printf 'Missing titan-voice-ui/pnpm-lock.yaml\n' >&2
  failed=1
elif ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm 9.15.9 is required to audit titan-voice-ui.\n' >&2
  failed=1
elif [[ "$(cd "$repo_root/titan-voice-ui" && pnpm --version)" != '9.15.9' ]]; then
  printf 'Use the titan-voice-ui packageManager version: pnpm 9.15.9.\n' >&2
  failed=1
else
  (cd "$repo_root/titan-voice-ui" && pnpm audit --audit-level=low) || failed=1
fi

exit "$failed"
