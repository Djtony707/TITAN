---
name: titan-smoke
description: Run TITAN smoke tests against the live Titan PC deployment. Tests all 180+ API endpoints, chat, voice, Command Post, sessions, skills, memory, security, VRAM, and UI.
user_invocable: true
---

# TITAN Smoke Test

Run the comprehensive smoke test suite against the live TITAN deployment.

## Usage

```bash
# Full test (all suites including chat and voice — takes ~3 min)
npx tsx scripts/smoke-test.ts --gateway=https://192.168.1.11:48420

# Fast test (skip LLM calls and voice — takes ~30 sec)
npx tsx scripts/smoke-test.ts --gateway=https://192.168.1.11:48420 --skip-chat --skip-voice

# Verbose (show all passing tests too)
npx tsx scripts/smoke-test.ts --gateway=https://192.168.1.11:48420 --verbose
```

## What It Tests

| Suite | Tests | What |
|-------|-------|------|
| System & Health | 8 | Version, stats, config, prometheus, profile |
| API Endpoints | 55+ | Status codes for all GET endpoints |
| Chat & LLM | 4 | Simple chat, tool invocation, empty content, model validation |
| Voice | 5 | TTS health, voice stream, audio presence, response quality |
| Command Post | 10+ | Issue CRUD, budget CRUD, approval workflow, org tree, runs |
| Sessions | 2 | List, search |
| Skills & Tools | 4 | Counts, models, personas |
| Memory | 3 | Graph, learning, soul |
| Workflows | 4 | Goals, cron, recipes, autopilot |
| Security | 3 | SQL injection, XSS, security endpoint |
| VRAM & GPU | 2 | GPU info, free VRAM |
| UI & SPA | 10+ | React root, JS/CSS bundles, panel routes |

## Prerequisites

- Titan PC must be running (`ssh titan "systemctl status titan-gateway"`)
- TTS must be running for voice tests (`ssh titan "systemctl status titan-tts"`)

## After Running

- If failures: read the failure details, check gateway logs (`ssh titan "tail -50 /var/log/titan-gateway.log"`)
- For voice failures: check TTS (`ssh titan "curl -s http://localhost:5006/health"`)
- For chat failures: check model (`curl -sk https://192.168.1.11:48420/api/config | python3 -c "import sys,json; print(json.load(sys.stdin).get('model'))"`)
