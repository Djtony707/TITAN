# TITAN Roadmap

This roadmap tracks implementation status against the active local-first runtime plan.

## Current Status (February 21, 2026)

### Completed
- Phase 1: SECURE/YOLO risk modes with CLI-only YOLO arming, expiry, and risk-mode trace tagging.
- Phase 2: Connectors foundation + encrypted secrets store.
  - `titan-connectors` crate with GitHub and Google Calendar connectors.
  - Connector metadata persisted in SQLite.
  - Encrypted local secrets store (`~/.titan/secrets.enc`) with Argon2id + XChaCha20-Poly1305.
  - Connector approvals integrated and finalized through existing approval flows.
  - Mission Control and API connector visibility.
- Phase 3: Autonomous jobs + scheduler.
  - Persistent `jobs` and `job_runs` SQLite tables.
  - In-process scheduler loop in `titan run` with bounded concurrency.
  - Job CLI (`add/list/show/pause/resume/run-now/remove`).
  - Jobs surfaced in Mission Control and `/api/jobs` routes.
  - Scheduler and YOLO job behavior integration tests.

### In Progress
- Documentation sync and release polish for all completed phases.

## Next Phases

## Phase 4: Continuous Work Sessions
- Pause/resume sessions on approval boundaries.
- Bounded replanning on failures with retry limits.
- Session progress persistence across restarts.
- Integration tests for pause/resume, bounded replans, restart continuity.

## Phase 5: Local LLM-First Profiles + Retrieval Bounds
- Router/planner/writer model profiles persisted and selectable.
- Ollama-first defaults with deterministic fallback path.
- Bounded memory retrieval controls (`retrieval_k`, token caps).
- Trace visibility for retrieval decisions and counts.

## Phase 6: Final UX + Release Readiness
- Mission Control polish (risk, connectors, jobs, sessions, approvals, skills, traces).
- Final docs pass for quickstart, safety, jobs, connectors, and operations.
- Smoke scripts and release checklist alignment.
- Final quality gate pass before release tag.

## Always-On Quality Gates

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

---

**Last Updated:** February 21, 2026
