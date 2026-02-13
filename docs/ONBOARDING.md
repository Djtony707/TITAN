# First Run Guide

Welcome to TITAN! This guide will get you up and running in minutes.

## Step 1: Configuration

Create your `.env` file:

```bash
cp .env.example .env
```

Required environment variables:

```bash
# Discord Bot (optional but recommended)
DISCORD_TOKEN=your_bot_token
DISCORD_APP_ID=your_application_id
DISCORD_CHANNELS=123456789,987654321  # Whitelist specific channels

# Paths
TITAN_WORKSPACE=~/Desktop/TITAN/workspace
TITAN_CONFIG=~/.titan
```

### Getting Discord Credentials

1. Go to https://discord.com/developers/applications
2. Create a New Application
3. Go to "Bot" tab and create a bot
4. Copy the token (keep it secret!)
5. Go to "OAuth2" → "URL Generator"
6. Select `bot` scope and `Send Messages`, `Read Message History` permissions
7. Use the generated URL to add bot to your server

## Step 2: Build

```bash
cargo build --release
```

## Step 3: Run

```bash
# Default mode (Collaborative)
./target/release/titan

# Supervised mode (all actions require approval)
./target/release/titan --supervised

# With Discord disabled (Web UI only)
./target/release/titan --no-discord
```

## Step 4: Verify

### Check Web Dashboard

Open http://127.0.0.1:3000 in your browser. You should see:
- System status
- Active goals
- Pending approvals

### Test Discord

In a channel where the bot has access:
```
!status
```

You should see a status response.

### Test Tools

Try interacting with the bot:
```
Titan: list files in workspace
Titan: what's in the docs folder?
```

## Step 5: Try a Demo Task

### Demo 1: Workspace Scan

Ask TitanBot:
```
Scan the workspace and tell me what you find
```

Expected behavior:
- Titan lists directory contents
- Summarizes file types
- (Collaborative mode: executes automatically)
- (Supervised mode: asks for approval)

### Demo 2: File Creation

Ask:
```
Create a file called notes.md with a summary of this conversation
```

Expected behavior:
- Titan prepares the write operation
- Requests approval (WRITE permission class)
- Upon approval, creates file
- Reports success

### Demo 3: Goal Request

Via Discord:
```
!goal Organize the workspace by file type
```

Or natural language:
```
Can you organize all files in the workspace into subdirectories by type?
```

Expected behavior:
- Titan creates a goal
- Plans the operation
- Executes in steps
- Reports progress

## Understanding Modes

### Supervised Mode
- Every action requires explicit approval
- Maximum security
- Good for learning how Titan works
- Use when you're unsure

### Collaborative Mode (Default)
- Read operations auto-execute
- Write/Execute/Network require approval
- Good balance of productivity and safety

### Autonomous Mode
- Allows pre-approved patterns
- Minimal interruption
- High trust only
- Full traceability

## Common Issues

### "Discord token invalid"
- Check DISCORD_TOKEN is correct
- Bot must have proper permissions
- Bot must be in the server

### "Cannot bind to port 3000"
- Port 3000 is in use
- Change port in config or stop other service
- Use `--no-web` if not needed

### "Permission denied"
- Titan workspace directory needs write access
- Check TITAN_WORKSPACE path exists

## Next Steps

- Read [Architecture Overview](./architecture.md) to understand the internals
- Review [Getting Started](./GETTING_STARTED.md) for more examples
- Check the [Roadmap](../ROADMAP.md) for upcoming features

## Getting Help

- Web Dashboard: http://127.0.0.1:3000
- Discord commands: `!help`
- System status: `!status`
- GitHub Issues: https://github.com/Djtony707/TITAN/issues

Happy automating! 🤖
