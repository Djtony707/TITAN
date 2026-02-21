# TITAN Jobs and Scheduler

Phase 3 adds persistent autonomous jobs executed by the runtime scheduler inside `titan run`.

## Storage (SQLite)

- `jobs`
  - `job_id`, `name`, `schedule_kind`, `schedule_value`, `goal_template`
  - `mode`, `allowed_scopes`, `enabled`
  - `created_at_ms`, `updated_at_ms`
  - `last_run_at_ms`, `last_status`, `last_goal_id`
- `job_runs`
  - `run_id`, `job_id`, `started_at_ms`, `finished_at_ms`
  - `status`, `goal_id`, `error_summary`

## CLI

```bash
titan job add --name "Scan Workspace" --interval 15m --template "scan workspace"
titan job add --name "Daily Summary" --cron "0 9 * * *" --template "summarize yesterday runs"
titan job list
titan job show <job_id>
titan job pause <job_id>
titan job resume <job_id>
titan job run-now <job_id>
titan job remove <job_id>
```

## Runtime scheduler (`titan run`)

- Scheduler loop runs in-process with bounded concurrency (`max 2` jobs executing concurrently).
- Enabled due jobs are converted into local CLI events and routed through the existing goal pipeline.
- Tool execution still passes through policy + approvals + traces.
- Risk mode behavior:
  - `secure`: normal approval gating applies.
  - `yolo`: approval requirements are bypassed only while YOLO is active; traces still include `risk_mode=yolo`.

## Mission Control/API

- `GET /api/jobs`
- `POST /api/jobs/{id}/run-now`
- `POST /api/jobs/{id}/pause`
- `POST /api/jobs/{id}/resume`
- Mission Control includes a Jobs section sourced from SQLite truth.
