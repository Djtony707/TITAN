# Getting Started with TITAN

Welcome! This guide will get you up and running with TITAN in under 5 minutes.

## Quick Install

```bash
# One-line installer
curl -fsSL https://raw.githubusercontent.com/titan/titan/main/scripts/install.sh | bash
```

Or manually:

```bash
# Clone
git clone https://github.com/titan/titan.git
cd titan

# Build
cargo build --release

# Configure
./scripts/configure.sh
```

## First Run

After installation, run the onboarding wizard:

```bash
titan onboard
```

This will:
1. Welcome you to TITAN
2. Create your first goal
3. Set your autonomy mode (supervised/collaborative/autonomous)
4. Configure Discord (optional)
5. Run a test

## Try Your First Goal

Once running, try:

```bash
# Discord
!goal Scan my Documents folder and summarize what you find

# Or CLI
titan --goal "Scan ~/Documents and create a summary"
```

## Choose Your Mode

### Supervised Mode (Safest)
Every action requires your approval.

```bash
titan --supervised
```

### Collaborative Mode (Default)
Read operations are automatic. Write/Execute/Network require approval.

```bash
titan  # Default mode
```

### Autonomous Mode (Powerful)
Full autonomy with emergency killswitch available.

```bash
titan --autonomous
```

## Key Commands

### Discord
- `!status` — Show system status
- `!goal <description>` — Submit a goal
- `!approve <id>` — Approve pending action
- `!mode <mode>` — Change autonomy mode
- `!emergency` — Stop all operations immediately

### Web Dashboard
Visit `http://127.0.0.1:3000` when running to see the dashboard.

## Next Steps

- Read the [Architecture Overview](./architecture.md)
- Review [Security Features](../SECURITY.md)
- Check the [Roadmap](../ROADMAP.md)
- Join our [Discord](https://discord.gg/titan)

## Need Help?

- GitHub Discussions: https://github.com/Djtony707/TITAN/discussions
- GitHub Issues: https://github.com/Djtony707/TITAN/issues
- Email: hello@titan.sh

---

**Welcome to the future of AI agents.** 🚀
