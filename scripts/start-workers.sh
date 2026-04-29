#!/bin/bash
set -e

TITAN_DIR="/Users/michaelelliott/Desktop/TitanBot/TITAN-main"
cd "$TITAN_DIR"

# Ensure gateway is running
if ! curl -s http://localhost:48420/api/health > /dev/null 2>&1; then
    echo "Starting TITAN gateway on port 48420..."
    nohup titan gateway > /tmp/titan-gateway.log 2>&1 &
    sleep 8
    if curl -s http://localhost:48420/api/health > /dev/null 2>&1; then
        echo "Gateway is UP"
    else
        echo "Gateway failed to start. Check /tmp/titan-gateway.log"
        cat /tmp/titan-gateway.log | tail -20
        exit 1
    fi
fi

# Start specialist agents via titan agents --spawn
echo "Spawning specialist agents..."

# Note: titan agents --spawn creates autonomous agent instances
# that process Command Post tasks via heartbeat inbox

titan agents --spawn builder --model ollama/qwen3.5:27b 2>&1 | tail -5
titan agents --spawn tester --model ollama/qwen3.5:27b 2>&1 | tail -5
titan agents --spawn docs --model ollama/qwen3.5:27b 2>&1 | tail -5
titan agents --spawn reviewer --model ollama/qwen3.5:27b 2>&1 | tail -5
titan agents --spawn devops --model ollama/qwen3.5:27b 2>&1 | tail -5

echo ""
echo "Active agents:"
titan agents --list 2>&1 || true

echo ""
echo "To check gateway: curl http://localhost:48420/api/health"
echo "To view gateway logs: tail -f /tmp/titan-gateway.log"
