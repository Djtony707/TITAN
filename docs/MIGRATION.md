# Migration Guide


## Upgrading to v7.0.0 "Independence" (from v5.x / v6.x)

**TL;DR: `npm install -g titan-agent@latest` and restart. The migration runner takes an automatic backup to `~/.titan/backups/` before touching anything; `titan backup restore <id>` rolls you back.**

What happens automatically on first boot:

- **Config migrations** — `organism.pressureThreshold` migrates `1.2 → 0.4` (the old default could never fire a Soma proposal). All new config blocks get safe defaults.
- **New config keys** (all optional, all safe defaults): `muscleMemory.{enabled,minOccurrences,verifyBeforePropose}` (self-learned skills — proposals only, nothing auto-adopts), `onboarded` (set by Welcome Mode).
- **Welcome Mode** — if your config already has a working provider, you'll never see it. Unconfigured installs now boot into a guided setup instead of refusing to start.
- **Reminders + Muscle Memory run their own timers** — they no longer require `daemon.enabled: true`.

Nothing is removed or renamed in v7.0.0: existing configs, sessions, memory, personas, recipes, and channels carry forward unchanged. New surfaces (💪 Muscle Memory widget, heartbeat notes, the free-roaming mascot) appear without any action on your part.

Moving to TITAN from another agent framework? This guide maps the concepts you already know to their TITAN equivalents and highlights what you gain.

TITAN is a TypeScript autonomous AI agent framework, distributed as the `titan-agent` npm package. It runs as a gateway server (default port 48420) with a built-in React dashboard called Mission Control.

---

## Coming from OpenClaw?

OpenClaw is a personal AI assistant focused on end-user conversations. TITAN is a developer framework for building autonomous AI systems.

### Concept Mapping

| OpenClaw | TITAN | Notes |
|----------|-------|-------|
| Extensions | Skills | TITAN skills are modular TypeScript modules in `src/skills/` |
| Characters | Personas | Configure via `~/.titan/titan.json` or the dashboard |
| Channels | Channels | Similar concept; TITAN ships 15 adapters (Discord, Slack, Telegram, etc.) |
| Model routing | Provider system | TITAN has 34 providers (4 native + 30 OpenAI-compatible) with fallback chains |
| Plugin API | Skill API + ContextEngine Plugins | TITAN plugins hook into the context pipeline |

### Key Differences

- **Developer-first**: TITAN exposes a full REST API (`POST /api/message`), SSE streaming, and WebSocket support. It is designed to be embedded, extended, and deployed -- not just chatted with.
- **Mesh networking**: Connect multiple TITAN instances as peers with automatic peer discovery and approval. OpenClaw runs as a single instance.
- **Sandbox code execution**: The `code_exec` tool runs user code in isolated Docker containers with an HTTP tool bridge. OpenClaw has no sandboxed execution environment.
- **LoRA fine-tuning**: TITAN supports training custom model adapters on your own data for self-improvement. OpenClaw relies on prompt engineering alone.
- **Prometheus metrics**: Built-in observability at `/metrics`. Monitor token usage, latency, tool invocations, and session counts.
- **Deliberative reasoning**: TITAN's reasoning engine breaks complex goals into sub-tasks with explicit planning steps.
- **Mission Control**: A React 19 SPA (Vite + Tailwind CSS 4) dashboard with panels for chat, voice, learning, security, workflows, memory graph, mesh management, and autopilot configuration.

### Getting Started

```bash
npm install -g titan-agent
titan gateway
# Dashboard at http://localhost:48420
```

Your OpenClaw extensions can be ported to TITAN skills. Each skill is a TypeScript file exporting a `register` function that adds tools to the agent's toolbox.

---

## Coming from CrewAI?

CrewAI is a Python framework for multi-agent orchestration. TITAN is a TypeScript framework where a single agent coordinates sub-agents, tools, and skills autonomously.

### Concept Mapping

| CrewAI | TITAN | Notes |
|--------|-------|-------|
| Crew | Orchestrator | TITAN's core agent acts as the orchestrator |
| Agent | Sub-Agent | TITAN can spawn sub-agents for complex tasks |
| Task | Goal | Goals are set via API, chat, or autopilot playbooks |
| Tools | Skills + Tools | Skills group related tools; TITAN ships ~149 tools across 91 skills |
| Memory | Memory Graph | Built-in persistent memory with graph relationships |
| Process (sequential/hierarchical) | Deliberative Reasoning | TITAN plans and executes steps with explicit reasoning |
| LLM config | Provider + Model config | Live-switchable via API or dashboard (no restart needed) |

### Code Comparison

**CrewAI (Python):**
```python
from crewai import Agent, Task, Crew

researcher = Agent(role="Researcher", goal="Find info", llm="gpt-4")
task = Task(description="Research AI trends", agent=researcher)
crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

**TITAN (API call):**
```bash
curl -X POST http://localhost:48420/api/message \
  -H "Content-Type: application/json" \
  -d '{"content": "Research AI trends and summarize findings", "sessionId": "research-01"}'
```

**TITAN (streaming):**
```bash
curl -X POST http://localhost:48420/api/message \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"content": "Research AI trends and summarize findings"}'
```

### What You Gain

- **No Python dependency**: TITAN is pure TypeScript/JavaScript with zero native dependencies.
- **Built-in GUI**: Mission Control dashboard out of the box. No need to build a frontend.
- **Voice integration**: LiveKit WebRTC voice support for spoken interaction with your agent.
- **15 channel adapters**: Deploy your agent to Discord, Slack, Telegram, Matrix, and more without writing adapter code.
- **Self-improvement**: LoRA fine-tuning lets TITAN learn from its own interactions.
- **Mesh networking**: Connect multiple TITAN instances for distributed workloads.
- **Autopilot mode**: Configure scheduled autonomous execution with active hours, goals, and playbooks.

---

## Coming from LangChain / LangGraph?

LangChain is a Python framework for building LLM-powered chains and agents. LangGraph extends it with graph-based orchestration. TITAN takes an all-in-one approach where the agent, tools, memory, retrieval, UI, and deployment are a single package.

### Concept Mapping

| LangChain / LangGraph | TITAN | Notes |
|------------------------|-------|-------|
| Chain | Recipe | Sequences of operations composed declaratively |
| Agent | Agent | TITAN's core agent with deliberative reasoning |
| Tools | Skills + Tools | 91 skills, ~149 tools included |
| VectorStore | RAG (built-in) | FTS5 full-text search + embedding-based vector search, no external DB needed |
| Memory (ConversationBufferMemory, etc.) | Memory Graph | Persistent, graph-structured memory with relationships |
| Callbacks | ContextEngine Plugins | Hook into the agent's processing pipeline |
| LangSmith (tracing) | Prometheus Metrics | Built-in observability at `/metrics` |
| LangServe (deployment) | Gateway mode | `titan gateway` serves the API immediately |

### What You Gain

- **All-in-one**: No need to separately install and configure a vector database (Pinecone, Chroma, Weaviate), a UI framework, a deployment server, or a tracing platform. TITAN includes RAG, a dashboard, an API server, and metrics out of the box.
- **No boilerplate**: LangChain requires assembling chains, selecting retrievers, configuring memory classes, and wiring components together. TITAN handles this internally.
- **Self-improvement**: LoRA fine-tuning on your own interaction data.
- **Voice and channels**: LiveKit voice + 15 channel adapters included.
- **Mesh networking**: Distribute work across multiple TITAN instances.
- **Single dependency**: `npm install titan-agent` gives you everything. No `requirements.txt` with 40+ transitive dependencies.

### Migration Path

If you have LangChain tools, you can wrap them as TITAN skills:

```typescript
// src/skills/custom/myTool.ts
import { SkillRegistrar } from 'titan-agent';

export function register(skill: SkillRegistrar) {
  skill.addTool({
    name: 'my_tool',
    description: 'Does something useful',
    parameters: { query: { type: 'string', required: true } },
    execute: async ({ query }) => {
      // Your logic here (port from LangChain tool)
      return { result: `Processed: ${query}` };
    },
  });
}
```

---

## Coming from Auto-GPT?

Auto-GPT is a Python autonomous agent that loops through think-plan-execute cycles. TITAN shares the autonomous execution model but adds significantly more infrastructure around it.

### Concept Mapping

| Auto-GPT | TITAN | Notes |
|----------|-------|-------|
| Agent loop | Deliberative Reasoning | Both loop autonomously; TITAN adds explicit planning steps |
| Commands | Skills + Tools | TITAN ships ~149 tools; Auto-GPT has ~20 built-in commands |
| Memory (JSON/Pinecone) | Memory Graph + RAG | Built-in FTS5 + embeddings, no external services needed |
| Plugins | Skills + ContextEngine Plugins | Two extension points: tools and pipeline hooks |
| Workspace | Sandbox | TITAN runs code in isolated Docker containers |
| .env config | `~/.titan/titan.json` + Dashboard | Live-configurable without restarts |

### What TITAN Adds

- **15 channel adapters**: Auto-GPT is CLI-only. TITAN deploys to Discord, Slack, Telegram, Matrix, and more.
- **LiveKit voice**: Talk to your agent over WebRTC. Auto-GPT has no voice support.
- **Mission Control GUI**: A full React dashboard for managing sessions, reviewing memory, configuring autopilot, and monitoring metrics. No CLI-only workflow.
- **Mesh networking**: Connect multiple TITAN instances as peers for distributed autonomous work. Auto-GPT runs as a single process.
- **Self-improvement with LoRA**: TITAN can fine-tune model adapters on its own interaction history. Auto-GPT relies on prompt context alone.
- **Configurable autopilot**: TITAN's autopilot mode supports schedules, active hours, goal-based execution, and playbooks. More granular control than Auto-GPT's continuous mode.
- **34 LLM providers with fallback chains**: If one provider fails, TITAN automatically falls back to the next. Auto-GPT supports OpenAI and a few alternatives.
- **Prometheus metrics**: Production-grade observability built in.
- **TypeScript**: If your team works in JavaScript/TypeScript, TITAN fits naturally into your stack without a Python runtime.

### Autopilot Comparison

Auto-GPT's continuous mode runs in a tight loop with optional human approval. TITAN's autopilot is more structured:

- Define active hours (e.g., only run 9am-5pm)
- Set specific goals or load playbooks from `docs/autopilot-playbooks/`
- Monitor progress via the Mission Control dashboard
- Pause, resume, or redirect at any time via API or GUI

---

## General Migration Tips

1. **Start with the gateway**: Run `titan gateway` and explore the dashboard at `http://localhost:48420`. Get familiar with the API before writing custom skills.

2. **Port tools first**: Your existing tools/functions map to TITAN skills. Each skill is a TypeScript file that registers one or more tools.

3. **Use the API**: TITAN's REST API (`POST /api/message`) is the primary interface. You can integrate it into any existing system with a simple HTTP call.

4. **Check the 34 providers**: TITAN likely already supports your preferred LLM. Configure it in `~/.titan/titan.json` or switch models live via the dashboard.

5. **Explore built-in skills**: Before porting custom tools, check if TITAN already has what you need across its 91 skills and ~149 tools.
