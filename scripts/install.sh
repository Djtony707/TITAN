#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Djtony707/TITAN.git"
INSTALL_DIR="${HOME}/TITAN"
BUILD_PROFILE="release"
RUN_ONBOARD="1"
INSTALL_BIN="1"
BIN_DIR="${HOME}/.local/bin"
INSTALL_DAEMON="0"

print_help() {
  cat <<'USAGE'
TITAN installer

Usage:
  ./scripts/install.sh [options]

Options:
  --dir <path>        Install/update directory (default: ~/TITAN)
  --repo <url>        Git repository URL
  --debug             Build debug profile instead of release
  --skip-onboard      Do not launch onboarding after build
  --no-onboard        Alias for --skip-onboard
  --no-link           Do not install/link titan to ~/.local/bin
  --bin-dir <path>    Binary install directory (default: ~/.local/bin)
  --install-daemon    Install startup daemon during setup
  -h, --help          Show this help message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --repo)
      REPO_URL="$2"
      shift 2
      ;;
    --debug)
      BUILD_PROFILE="debug"
      shift
      ;;
    --skip-onboard)
      RUN_ONBOARD="0"
      shift
      ;;
    --no-onboard)
      RUN_ONBOARD="0"
      shift
      ;;
    --no-link)
      INSTALL_BIN="0"
      shift
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --install-daemon)
      INSTALL_DAEMON="1"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ensure_rust_toolchain() {
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    return
  fi

  need_cmd curl

  echo "Rust toolchain not found. Installing via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

  if [[ -f "${HOME}/.cargo/env" ]]; then
    # shellcheck source=/dev/null
    source "${HOME}/.cargo/env"
  fi

  need_cmd cargo
  need_cmd rustc
}

install_titan_bin() {
  local source_bin="$1"
  local target_bin="${BIN_DIR}/titan"
  mkdir -p "${BIN_DIR}"
  cp "${source_bin}" "${target_bin}"
  chmod +x "${target_bin}"
  echo "==> Installed titan command at ${target_bin}"
  case ":$PATH:" in
    *":${BIN_DIR}:"*) ;;
    *)
      echo "==> ${BIN_DIR} is not in PATH."
      echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
      echo "export PATH=\"${BIN_DIR}:\$PATH\""
      ;;
  esac
}

run_titan() {
  if [[ "${INSTALL_BIN}" == "1" ]]; then
    titan "$@"
  else
    "${TITAN_BIN}" "$@"
  fi
}

echo "==> TITAN installer starting"
echo "repo: ${REPO_URL}"
echo "dir:  ${INSTALL_DIR}"

need_cmd git
ensure_rust_toolchain

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "==> Existing TITAN checkout found. Updating..."
  git -C "${INSTALL_DIR}" fetch --all --tags
  git -C "${INSTALL_DIR}" pull --ff-only
else
  echo "==> Cloning TITAN..."
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

echo "==> Building TITAN (${BUILD_PROFILE})..."
if [[ "${BUILD_PROFILE}" == "release" ]]; then
  cargo build --release
  TITAN_BIN="./target/release/titan"
else
  cargo build
  TITAN_BIN="./target/debug/titan"
fi

echo "==> Build complete"
echo "binary: ${INSTALL_DIR}/${TITAN_BIN#./}"

if [[ "${INSTALL_BIN}" == "1" ]]; then
  install_titan_bin "${INSTALL_DIR}/${TITAN_BIN#./}"
  TITAN_CMD="titan"
else
  TITAN_CMD="${TITAN_BIN}"
fi

if [[ "${RUN_ONBOARD}" == "1" ]]; then
  if [[ -t 0 && -t 1 ]]; then
    echo "==> Launching setup wizard..."
    if [[ "${INSTALL_DAEMON}" == "1" ]]; then
      run_titan setup --install-daemon
    else
      run_titan setup
    fi
  else
    echo "==> Non-interactive shell detected; skipping onboarding wizard."
    if [[ "${INSTALL_DAEMON}" == "1" ]]; then
      echo "Run this next: ${TITAN_CMD} setup --install-daemon"
    else
      echo "Run this next: ${TITAN_CMD} setup"
    fi
  fi
else
  echo "==> Onboarding skipped by flag."
  if [[ "${INSTALL_DAEMON}" == "1" ]]; then
    echo "Run this next: ${TITAN_CMD} setup --install-daemon"
  else
    echo "Run this next: ${TITAN_CMD} setup"
  fi
fi

echo "==> Quick validation commands"
echo "${TITAN_CMD} doctor"
echo "${TITAN_CMD} model show"
echo "${TITAN_CMD} comm list"
