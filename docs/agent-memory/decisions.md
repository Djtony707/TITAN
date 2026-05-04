# Decisions

> Tony-approved decisions with context, date, and rationale.
> Each entry is a typed memory.

---

## Decision: Create KIMI_COO_STATE.md

- **type:** DECISION
- **date:** 2026-05-03
- **source:** Tony Elliott
- **confidence:** high
- **verified_by:** Tony said "Create a local file named KIMI_COO_STATE.md"
- **content:** Create `KIMI_COO_STATE.md` in the TITAN repo root. Use it as operational memory between sessions. Include who I am, machine roles, repo paths, branch state, known issues, priorities, and decisions. Do not include secrets.
- **rationale:** Persistent memory across sessions since AI memory resets.
- **review_after:** 2026-05-10

## Decision: Adopt Superpowers Workflow

- **type:** DECISION
- **date:** 2026-05-03
- **source:** Tony Elliott
- **confidence:** high
- **verified_by:** Tony said "Use a Superpowers-inspired workflow for all TITAN engineering work"
- **content:** Use 10-step workflow: Recon → Brainstorm → Spec → Plan → Worktree → Patch → Test → Review → Verify → Handoff. Core principles: Evidence over claims, small changes over giant rewrites, tests before confidence, plans before patches, no risky actions without approval.
- **rationale:** Structured, safe engineering process that prevents reckless changes.
- **review_after:** never

## Decision: TITAN Universe Recon Mission

- **type:** DECISION
- **date:** 2026-05-03
- **source:** Tony Elliott
- **confidence:** high
- **verified_by:** Tony provided detailed recon instructions
- **content:** Map all TITAN-related code, docs, notes, prompts, GitNexus files, and runtime folders across MacBook and Titan PC. Recon only — no edits, no installs, no deletes, no commits, no pushes, no remote changes.
- **rationale:** Understand the full landscape before making changes.
- **review_after:** never

## Decision: Create Source-of-Truth Plan

- **type:** DECISION
- **date:** 2026-05-03
- **source:** Tony Elliott
- **confidence:** high
- **verified_by:** Tony said "Create a single TITAN source-of-truth plan"
- **content:** Create a plan that decides active repo, identifies stale copies, proposes organization, suggests docs structure, creates sync plan between MacBook and Titan PC, and outlines GitNexus integration. Do not edit files yet — output recommendations only.
- **rationale:** Prevent data loss from multiple copies and establish clear workflow.
- **review_after:** never

## Decision: Autonomy Boot

- **type:** DECISION
- **date:** 2026-05-03
- **source:** Tony Elliott
- **confidence:** high
- **verified_by:** Tony provided full autonomy framework with levels 0-7
- **content:** Operate under autonomy levels: 0=Recon, 1=Self-check, 2=Safe self-heal, 3=Branch/worktree patching, 4=Verify/benchmark, 5+=requires approval. Build self-learning architecture: repo brain, session state, typed memory, reflexion loop, skill learning, benchmark loop, self-healing, GitNexus integration, Titan PC integration.
- **rationale:** Enable autonomous work within safe boundaries.
- **review_after:** never

---

## Pending Decisions (Need Tony Input)

| Decision | Status | Notes |
|---|---|---|
| Push handoff doc (`95fbb07`) to origin | ⏳ Pending | MacBook 1 commit ahead |
| Commit titan-saas uncommitted work | ⏳ Pending | Large WIP on Titan PC |
| Commit titan-synapse uncommitted work | ⏳ Pending | Model changes on MacBook |
| Delete stale folders on Titan PC | ⏳ Pending | Desktop copies may be dead |
| Run `npm run build` on MacBook | ⏳ Pending | Need to verify build works |
| Restart titan.service on Titan PC | ⏳ Pending | Production impact |

---

*Last updated: 2026-05-03 by KIMI-COO 🧠*
