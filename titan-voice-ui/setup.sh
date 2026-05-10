#!/bin/bash
# TITAN Voice UI Setup — LiveKit agent-starter-react
# Clones the official starter, patches it for local TITAN use.
#
# Usage: cd titan-voice-ui && bash setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Clone agent-starter-react if not already present
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "Cloning livekit-examples/agent-starter-react..."
  TEMP_DIR=$(mktemp -d)
  git clone --depth 1 https://github.com/livekit-examples/agent-starter-react.git "$TEMP_DIR"
  # Move contents (excluding .git) into this directory
  shopt -s dotglob
  mv "$TEMP_DIR"/* "$SCRIPT_DIR/" 2>/dev/null || true
  rm -rf "$TEMP_DIR/.git"
  rm -rf "$SCRIPT_DIR/.git"
  shopt -u dotglob
  echo "Cloned successfully."
fi

# Create .env.local with TITAN-specific config
cat > "$SCRIPT_DIR/.env.local" << 'EOF'
# LiveKit Server (self-hosted on Titan PC)
LIVEKIT_URL=ws://<titan-host>:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret

# App title
NEXT_PUBLIC_APP_TITLE=TITAN Voice
EOF

echo "Created .env.local"

# Install dependencies
echo "Installing dependencies..."
npm install

echo ""
echo "=== TITAN Voice UI Ready ==="
echo "Start with: npm run dev"
echo "Opens at:   http://localhost:3000"
echo ""
echo "Make sure LiveKit server + voice agent are running:"
echo "  docker compose -f docker-compose.voice.yml up -d"
