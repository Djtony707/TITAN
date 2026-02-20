#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CLI-only install path for non-interactive environments.
"${SCRIPT_DIR}/install.sh" --skip-onboard "$@"
