# Installation Guide

Detailed installation instructions for TITAN.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Install](#quick-install)
- [Manual Install](#manual-install)
- [Post-Installation](#post-installation)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required

- **Rust** 1.75 or higher ([Install](https://rustup.rs/))
- **SQLite** 3.x (usually pre-installed on most systems)
- **Git**

### Supported Platforms

- ✅ Linux (Ubuntu 20.04+, Debian, Fedora, Arch)
- ✅ macOS (10.15+)
- ✅ Windows (via WSL2 - strongly recommended)

### Hardware Recommendations

| Use Case | CPU | RAM | Disk |
|----------|-----|-----|------|
| Basic | 2 cores | 4GB | 10GB |
| Standard | 4 cores | 8GB | 20GB |
| Heavy (local LLMs) | 8+ cores | 32GB+ | 50GB |

---

## Quick Install

The fastest way to get TITAN running:

```bash
# One-line installer (Linux/macOS/WSL2)
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install.sh | bash
```

This will:
1. Check system prerequisites
2. Install Rust if needed
3. Clone the TITAN repository
4. Build the project
5. Run the configuration wizard

---

## Manual Install

For more control or if the quick install doesn't work:

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

Verify:
```bash
rustc --version  # Should show 1.75+
```

### 2. Clone Repository

```bash
git clone https://github.com/Djtony707/TITAN.git
cd TITAN
```

### 3. Build

```bash
# Debug build (faster compile, slower runtime)
cargo build

# Release build (slower compile, faster runtime) - RECOMMENDED
cargo build --release
```

### 4. Configure

```bash
# Run configuration wizard
./scripts/configure.sh

# Or create .env manually
cat > .env << EOF
TITAN_WORKSPACE=/home/$(whoami)/titan-workspace
DISCORD_TOKEN=your_discord_bot_token_here
RUST_LOG=titan=info
EOF
```

### 5. Create Workspace

```bash
mkdir -p ~/titan-workspace
```

---

## Post-Installation

### Run Security Check

```bash
./scripts/security-check.sh
```

### Start TITAN

```bash
# Run the binary directly
./target/release/titan

# Or with a specific mode
./target/release/titan --supervised
```

### Systemd Service (Linux)

To run TITAN as a service:

```bash
# Create service file
sudo tee /etc/systemd/system/titan.service << EOF
[Unit]
Description=TITAN AI Agent
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/TITAN
EnvironmentFile=$HOME/TITAN/.env
ExecStart=$HOME/TITAN/target/release/titan
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable titan
sudo systemctl start titan

# Check status
sudo systemctl status titan
```

---

## Troubleshooting

### Build Fails

**Problem:** `cargo build` fails with linking errors  
**Solution:**
```bash
# Ubuntu/Debian
sudo apt install build-essential pkg-config libssl-dev

# Fedora
sudo dnf install gcc openssl-devel

# macOS
xcode-select --install
```

### SQLite Not Found

**Problem:** `sqlite3.h not found`  
**Solution:**
```bash
# Ubuntu/Debian
sudo apt install libsqlite3-dev

# Fedora
sudo dnf install sqlite-devel

# macOS (usually pre-installed)
brew install sqlite3
```

### Permission Denied

**Problem:** Cannot write to workspace  
**Solution:**
```bash
# Check workspace exists and is writable
ls -la ~/titan-workspace

# Fix permissions if needed
mkdir -p ~/titan-workspace
chmod 755 ~/titan-workspace
```

### Discord Bot Doesn't Respond

**Problem:** Bot online but not responding to commands  
**Solution:**
1. Check token is correct in `.env`
2. Ensure bot has "Message Content Intent" enabled in [Discord Developer Portal](https://discord.com/developers/applications)
3. Verify bot has permission to read/send messages in the channel

---

## Next Steps

After installation:

1. Read [Getting Started](GETTING_STARTED.md)
2. Review [First Run Walkthrough](first_run.md)
3. Check [Security Documentation](../SECURITY.md)

Join our community:
- [Discord](https://discord.gg/titan)
- [GitHub Discussions](https://github.com/Djtony707/TITAN/discussions)

---

**Need more help?** Open an issue at https://github.com/Djtony707/TITAN/issues
