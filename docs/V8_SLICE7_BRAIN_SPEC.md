# v8 Slice 7 — Company Brain: Part 1 (Brain Store) Spec

*Design: Claude (Fable 5). Review: gpt-5.6-sol (council, N1–N3). Status: build in progress.*

## What this is

The pooled, attributed company memory: what one teammate learns, the team knows —
and you can see who learned it, from where, and revoke it. The substrate the
hire/fire flow and the "feels like a real team" surfaces stand on.

Build order (council N1): **store first** (this spec), then the meta-agent
hire/fire flow as its first consumer, then embeddings/graph polish.

## Design constraints (from the council)

- **Events are truth; projections are cache.** Every brain mutation is a signed,
  hash-chained event on the existing company log (substrate `eventLog.ts` —
  ed25519 actor binding, prev-hash chaining, authority tables, append-only).
  Projections (including the retrieval index) fold from the log and are
  rebuildable from genesis. Deleting `brain.db` loses nothing.
- **Local by default** (council N2): retrieval is SQLite FTS5 (`node:sqlite`,
  already the company-layer floor). Lexical ranking is the zero-config path;
  embeddings arrive later as an optional adapter. No native-binary deps.
- **Attribution + scope** (council N3): every entry carries its author principal
  and a visibility scope. Retrieval enforces the requester's visibility. The
  same principle extends to recipes (route-time provenance check — tracked
  separately in the registry work).
- **Append-only with tombstones**: retraction is a `brain.tombstone` event;
  projections hide tombstoned entries; the log keeps the full audit trail.

## New event kinds (closed-validator style, mirroring slice-2 queue mode)

| Kind | Payload | Authority |
|---|---|---|
| `brain.entry` | `{ entryKind: observation\|decision\|lesson\|commitment, text ≤2000, scope: private\|company, tags?: string[], eventRef? }` | `'*'` — any registered actor, always attributed to its own signature |
| `brain.tombstone` | `{ targetId, reason }` | author of target, `ceo`, or `user` (validator-enforced) |
| `agent.hired` | `{ agentId, displayName, role, charter, harness?, model? }` | `ceo`, `user` |
| `agent.retired` | `{ agentId, reason }` | `ceo`, `user` |
| `recipe.promoted` | `{ recipeId, signature, shadowEpoch, comparisons, successes }` | `user` (registry bridge); idempotent per `(recipeId, shadowEpoch)` — validator-enforced (council N3: no double-publish) |

`openCompanyFeature(titanHome, { brain: true })` enables the kinds + the
built-in brain validator (internal, not caller-suppliable — same closure as
queue mode). Fine-grained rules live in the validator:

- `brain.tombstone`: target must exist, be a `brain.entry`, not already
  tombstoned; actor must be the target's author, `ceo`, or `user`.
- `brain.entry` from a retired agent: refused (`agent.retired` revokes append
  rights — checked against the fold of hired/retired events).
- `agent.hired`: agentId must be valid (keys.ts containment gate) and not
  currently hired; `agent.retired`: must be currently hired; `ceo`/`user`
  cannot be retired.
- `recipe.promoted`: duplicate `(recipeId, shadowEpoch)` refused (idempotency).

## Projections (`$TITAN_HOME/company/brain.db`, rebuildable)

- `brain_entries(event_id, ts, actor, entry_kind, text, scope, tags, tombstoned)`
- `brain_fts` — FTS5 over `text` (+`tags`), external-content on `brain_entries`
- `roster(agent_id, display_name, role, charter, harness, model, status, hired_ts, retired_ts)`
- `meta(log_cursor)` — incremental fold position; `rebuildBrainProjections()`
  drops everything and refolds from genesis.

## Retrieval API (`brainQuery.ts`)

- `queryBrain({ q, principal, limit })` — FTS5 `bm25` blended with recency
  decay; visibility: `company`-scoped entries + the principal's own `private`
  entries. Deterministic (no model calls).
- `brainTail(principal, limit)` — the principal's own attributed stream.
- `renderBrainForPrompt(principal)` — pooled context block: top-k relevant
  company knowledge (attributed: *"Scout learned: …"*) + own recent stream.
  Supersedes `memoryStream.renderMemoryForPrompt` for company agents; the
  per-agent jsonl streams remain for non-company (flag-off) paths.

## Seeding (`brainSeed.ts`)

`seedBrainFromV7(titanHome)` — one-shot import: recent receipts and persisted
traces become `brain.entry` observations by `user`, tagged `legacy-v7`.
Idempotent via a `brain.entry` tag check. Runs only when the user opts in
(first company boot offers it).

## Non-goals (Part 1)

Embedding vectors, the temporal graph, team-level scope (reserved in the enum),
the generative hiring interview UI (Part 2 consumes `agent.hired`), and the
recipe route-time scope check (registry work, tracked in the plan).
