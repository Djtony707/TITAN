# Why TITAN v8 Looks The Way It Does

*Design context, August 2026. This documents the industry moment v8 ships into and
the principles it borrows, so future contributors understand what v8 is answering.*

## The July–August 2026 shift

In a six-week window, the agent industry converged on a new shape:

- **Block Buzz** (July 21): a self-hosted workspace where agents are first-class
  teammates with their own cryptographic identities. Block's framing: *"the
  bottleneck moved from intelligence to coordination"* — models can do the work;
  teams need somewhere to do it together. And: *"nobody enjoyed being middleware"*
  — humans copy-pasting between an agent harness and team chat is the failure mode.
- **Claude Cowork** (July 7) and **ChatGPT Work** (July 9): the two biggest labs
  moved from chat to *work* — agents that hold a task for hours and hand back a
  finished deliverable, not a reply.
- **Google Workspace Studio + A2A**, **Microsoft Agent Framework** (hosted agents,
  multi-tenant admin), **Salesforce Agentforce**: the enterprise wave — orchestration,
  governance, and audit as table stakes.
- **Memmy** and similar: shared, attributed memory across agents replacing
  per-tool silos.

## The six principles of the new generation

1. **Work, not chat.** The unit of value is a finished deliverable. Surfaces are
   queues, missions, and reviews — not message threads.
2. **Coordination over intelligence.** The workspace is the product. Humans and
   agents share one substrate instead of humans ferrying context between silos.
3. **Accountable identity.** Agents sign their work. Attribution, receipts, and
   audit trails are structural, not bolted on.
4. **Protocol-first.** MCP for tools, ACP for clients, A2A for agent-to-agent.
   Openness and self-hostability are competitive features, not ideology.
5. **Shared memory with attribution.** What one agent learns, the team knows —
   and you can see who learned it and from where.
6. **Progressive trust.** Autonomy is earned through gates: approval flows,
   shadow trials, execution gating. Nothing self-promotes without evidence.

## How v8 answers each

| Principle | v8 answer |
|---|---|
| Work, not chat | Missions, work queue, autopilot (slices 1–2) |
| Coordination | The company layer: crew, dispatch, roles (slices 1–6) |
| Accountable identity | Receipts + trace/trajectory records (RECORD) |
| Protocol-first | MCP native; ACP adapter on the roadmap |
| Shared memory | The company brain: FTS + embeddings + graph, attributed streams (slice 7) |
| Progressive trust | RECOGNIZE → COMPILE → shadow trials → gated activation (slices 4–6) |

TITAN's differentiator inside this wave stays what it has always been: the crew
is *likeable* — named specialist personas you enjoy working with, not anonymous
enterprise workers. v8 gives that crew a company to work in.
