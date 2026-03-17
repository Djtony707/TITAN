# Third-Party Notices

This file lists the open-source software used by TITAN, organized by category.

---

## Core Infrastructure

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| Express | MIT | https://expressjs.com/ | HTTP server framework |
| ws | MIT | https://github.com/websockets/ws | WebSocket server |
| Zod | MIT | https://zod.dev/ | Schema validation |
| Commander.js | MIT | https://github.com/tj/commander.js | CLI framework |
| dotenv | BSD-2-Clause | https://github.com/motdotla/dotenv | Environment variables |
| node-cron | ISC | https://github.com/node-cron/node-cron | Task scheduling |
| uuid | MIT | https://github.com/uuidjs/uuid | ID generation |

## AI & NLP

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| LiveKit | Apache-2.0 | https://livekit.io/ | WebRTC voice platform |
| Playwright | Apache-2.0 | https://playwright.dev/ | Browser automation |
| Stagehand | MIT | https://github.com/browserbase/stagehand | AI browser interaction |
| @mozilla/readability | Apache-2.0 | https://github.com/mozilla/readability | Article extraction |
| jsdom | MIT | https://github.com/jsdom/jsdom | DOM implementation |
| turndown | MIT | https://github.com/mixmark-io/turndown | HTML to Markdown conversion |

## Frontend (Mission Control v2)

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| React 19 | MIT | https://react.dev/ | UI framework |
| Vite | MIT | https://vite.dev/ | Build tool |
| Tailwind CSS 4 | MIT | https://tailwindcss.com/ | CSS framework |
| React Router v7 | MIT | https://reactrouter.com/ | Client-side routing |
| react-markdown | MIT | https://github.com/remarkjs/react-markdown | Markdown rendering |
| remark-gfm | MIT | https://github.com/remarkjs/remark-gfm | GitHub-flavored Markdown |
| rehype-highlight | MIT | https://github.com/rehypejs/rehype-highlight | Syntax highlighting |
| Lucide React | ISC | https://lucide.dev/ | Icon library |
| Motion | MIT | https://motion.dev/ | Animations |

## Voice Stack (Docker)

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| LiveKit Server | Apache-2.0 | https://github.com/livekit/livekit | WebRTC SFU for real-time voice |
| LiveKit Agents SDK | Apache-2.0 | https://github.com/livekit/agents | Python voice agent framework |
| LiveKit Server SDK (Node) | Apache-2.0 | https://github.com/livekit/server-sdk-js | Token generation for voice sessions |
| @livekit/components-react | Apache-2.0 | https://github.com/livekit/components-js | React components for LiveKit rooms |
| faster-whisper | MIT | https://github.com/SYSTRAN/faster-whisper | CTranslate2-based speech-to-text engine |
| faster-whisper-server | MIT | https://github.com/fedirz/faster-whisper-server | OpenAI-compatible STT HTTP server |
| Kokoro | Apache-2.0 | https://huggingface.co/hexgrad/Kokoro-82M | 82M parameter text-to-speech model by Hexgrad |
| Kokoro-FastAPI | MIT | https://github.com/remsky/Kokoro-FastAPI | OpenAI-compatible TTS HTTP server wrapping Kokoro |
| Silero VAD | MIT | https://github.com/snakers4/silero-vad | Voice activity detection for speech segmentation |
| Caddy | Apache-2.0 | https://caddyserver.com/ | Reverse proxy for voice services |

## NVIDIA (Optional Integrations)

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| Nemotron 3 Models | NVIDIA Open Model License | https://build.nvidia.com | LLM inference via NIM API (local/cloud) |
| Nemotron-ASR-Streaming | NVIDIA Open Model License | https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b | Low-latency streaming speech recognition |
| cuOpt | Apache-2.0 | https://github.com/NVIDIA/cuopt | GPU-accelerated optimization (routing, MILP, LP) |
| OpenShell | Open Source | https://github.com/NVIDIA/OpenShell | Agent sandbox runtime with policy enforcement |
| Riva WebSocket Bridge | MIT | https://github.com/nvidia-riva/websocket-bridge | gRPC-to-HTTP bridge for speech services |
| Riva Common Protos | MIT | https://github.com/nvidia-riva/common | gRPC service definitions for ASR/TTS |
| NVIDIA AI-Q Blueprint | Open Source | https://github.com/NVIDIA-AI-Blueprints/aiq | Deep research agent with citations |

Licensed by NVIDIA Corporation under the NVIDIA Open Model License.

## Channels (Optional)

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| discord.js | Apache-2.0 | https://discord.js.org/ | Discord integration |
| grammY | MIT | https://grammy.dev/ | Telegram bots |
| @slack/bolt | MIT | https://slack.dev/bolt-js/ | Slack apps |
| @whiskeysockets/baileys | MIT | https://github.com/WhiskeySockets/Baileys | WhatsApp integration |
| matrix-js-sdk | Apache-2.0 | https://github.com/matrix-org/matrix-js-sdk | Matrix protocol |
| botbuilder | MIT | https://github.com/microsoft/botframework-sdk | Microsoft Teams |
| irc-framework | MIT | https://github.com/kiwiirc/irc-framework | IRC networks |
| bonjour-service | MIT | https://github.com/onlxltd/bonjour-service | mDNS discovery |

## Dev Tools

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| TypeScript | Apache-2.0 | https://www.typescriptlang.org/ | Type system |
| Vitest | MIT | https://vitest.dev/ | Test framework |
| tsup | MIT | https://tsup.egoist.dev/ | Bundler |
| ESLint | MIT | https://eslint.org/ | Linter |
| Chalk | MIT | https://github.com/chalk/chalk | Terminal colors |
| Ora | MIT | https://github.com/sindresorhus/ora | Terminal spinners |
| Boxen | MIT | https://github.com/sindresorhus/boxen | Terminal boxes |
| Inquirer | MIT | https://github.com/SBoudrias/Inquirer.js | Interactive prompts |

## Architectural Inspiration

| Project | License | URL | Influence |
|---------|---------|-----|-----------|
| OpenClaw | MIT | https://github.com/openclaw/openclaw | Architecture, CLI design, workspace patterns |
| Graphiti | Apache-2.0 | https://github.com/getzep/graphiti | Temporal knowledge graph concepts |
| Skyvern | AGPL-3.0 | https://github.com/Skyvern-AI/skyvern | Browser automation patterns (separate service, not bundled) |

## Persona Definitions

| Project | License | URL | Usage |
|---------|---------|-----|-------|
| agency-agents | MIT | https://github.com/msitarzewski/agency-agents | Agent personality definitions adapted for TITAN personas |

Copyright (c) 2025 AgentLand Contributors. MIT License.

---

This file is provided for informational purposes. Each project retains its own license. See individual project repositories for full license text.
