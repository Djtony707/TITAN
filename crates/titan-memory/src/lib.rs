use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, params};
use titan_core::{Goal, GoalStatus, PendingApprovalAction, StepResult, TaskRunResult, TraceEvent};
use uuid::Uuid;

#[derive(Debug)]
pub struct StoredGoal {
    pub id: String,
    pub description: String,
    pub status: String,
    pub dedupe_key: Option<String>,
}

pub struct MemoryStore {
    conn: Connection,
    db_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ApprovalRecord {
    pub id: String,
    pub nonce: String,
    pub goal_id: Option<String>,
    pub tool_name: String,
    pub capability: String,
    pub input: String,
    pub status: String,
    pub requested_by: Option<String>,
    pub resolved_by: Option<String>,
    pub expires_at_ms: i64,
    pub decision_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolRunRecord {
    pub id: String,
    pub approval_id: Option<String>,
    pub tool_name: String,
    pub status: String,
    pub output: String,
}

#[derive(Debug, Clone)]
pub struct EpisodicMemoryRecord {
    pub id: i64,
    pub goal_id: String,
    pub summary: String,
    pub source: String,
}

pub struct RunPersistenceBundle<'a> {
    pub run: &'a TaskRunResult,
    pub source: &'a str,
    pub requested_by: Option<&'a str>,
    pub approval_ttl_ms: u64,
}

pub struct RunPersistenceOutcome {
    pub approval_id: Option<String>,
}

impl MemoryStore {
    pub fn open(db_path: &Path) -> Result<Self> {
        // Ensure parent directory exists so sqlite can create/open the db file.
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create db directory {}", parent.display()))?;
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("failed to open database at {}", db_path.display()))?;
        let store = Self {
            conn,
            db_path: db_path.to_path_buf(),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;

        self.apply_migration(
            1,
            "base_runtime_tables",
            r#"
            CREATE TABLE IF NOT EXISTS goals (
              id TEXT PRIMARY KEY,
              description TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS trace_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              goal_id TEXT NOT NULL,
              event_type TEXT NOT NULL,
              detail TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(goal_id) REFERENCES goals(id)
            );

            CREATE TABLE IF NOT EXISTS approval_requests (
              id TEXT PRIMARY KEY,
              tool_name TEXT NOT NULL,
              capability TEXT NOT NULL,
              input TEXT NOT NULL,
              status TEXT NOT NULL,
              decision_reason TEXT,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS tool_runs (
              id TEXT PRIMARY KEY,
              approval_id TEXT,
              tool_name TEXT NOT NULL,
              status TEXT NOT NULL,
              output TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(approval_id) REFERENCES approval_requests(id)
            );
            "#,
        )?;

        self.apply_migration(
            2,
            "goal_dedupe_and_approval_hardening",
            r#"
            ALTER TABLE goals ADD COLUMN dedupe_key TEXT;
            ALTER TABLE approval_requests ADD COLUMN nonce TEXT;
            ALTER TABLE approval_requests ADD COLUMN requested_by TEXT;
            ALTER TABLE approval_requests ADD COLUMN resolved_by TEXT;
            ALTER TABLE approval_requests ADD COLUMN expires_at_ms INTEGER;
            "#,
        )?;

        self.apply_migration(
            3,
            "semantic_and_procedural_memory",
            r#"
            CREATE TABLE IF NOT EXISTS semantic_facts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              namespace TEXT NOT NULL,
              fact_key TEXT NOT NULL,
              fact_value TEXT NOT NULL,
              source TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS procedural_strategies (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              strategy_name TEXT NOT NULL,
              strategy_body TEXT NOT NULL,
              confidence REAL NOT NULL,
              source TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;

        self.apply_migration(
            4,
            "episodic_memory_and_goal_linked_approvals",
            r#"
            ALTER TABLE approval_requests ADD COLUMN goal_id TEXT;

            CREATE TABLE IF NOT EXISTS episodic_memories (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              goal_id TEXT NOT NULL,
              summary TEXT NOT NULL,
              source TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(goal_id) REFERENCES goals(id)
            );
            "#,
        )?;

        self.apply_migration(
            5,
            "run_plan_and_step_tables",
            r#"
            CREATE TABLE IF NOT EXISTS run_plans (
              id TEXT PRIMARY KEY,
              goal_id TEXT NOT NULL,
              intent TEXT NOT NULL,
              selected_candidate_id TEXT NOT NULL,
              selected_score REAL NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(goal_id) REFERENCES goals(id)
            );

            CREATE TABLE IF NOT EXISTS run_steps (
              id TEXT PRIMARY KEY,
              goal_id TEXT NOT NULL,
              plan_id TEXT NOT NULL,
              step_id TEXT NOT NULL,
              tool_name TEXT NOT NULL,
              permission TEXT NOT NULL,
              input TEXT,
              status TEXT NOT NULL,
              output TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(goal_id) REFERENCES goals(id),
              FOREIGN KEY(plan_id) REFERENCES run_plans(id)
            );
            "#,
        )?;

        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_dedupe_key
             ON goals(dedupe_key)
             WHERE dedupe_key IS NOT NULL",
            [],
        )?;
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_runs_approval_id
             ON tool_runs(approval_id)
             WHERE approval_id IS NOT NULL",
            [],
        )?;

        self.conn.execute(
            "UPDATE approval_requests
             SET nonce = COALESCE(nonce, id),
                 expires_at_ms = COALESCE(expires_at_ms, CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER) + 300000)",
            [],
        )?;

        Ok(())
    }

    fn apply_migration(&self, version: i64, name: &str, sql: &str) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("SELECT 1 FROM schema_migrations WHERE version = ?1 LIMIT 1")?;
        let mut rows = stmt.query(params![version])?;
        if rows.next()?.is_some() {
            return Ok(());
        }

        let tx = self.conn.unchecked_transaction()?;
        for raw in sql.split(';') {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Err(err) = tx.execute(trimmed, []) {
                // Migrations are written to be backward-compatible with existing DBs.
                // Duplicate-column style errors are safe to ignore.
                let message = err.to_string().to_lowercase();
                if !(message.contains("duplicate column")
                    || message.contains("already exists")
                    || message.contains("duplicate"))
                {
                    return Err(err.into());
                }
            }
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
            params![version, name],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn create_goal(&self, goal: &Goal) -> Result<()> {
        self.conn.execute(
            "INSERT INTO goals (id, description, status, dedupe_key) VALUES (?1, ?2, ?3, ?4)",
            params![
                goal.id,
                goal.description,
                goal.status.as_str(),
                goal.dedupe_key
            ],
        )?;
        Ok(())
    }

    pub fn persist_run_bundle(
        &mut self,
        bundle: RunPersistenceBundle<'_>,
    ) -> Result<RunPersistenceOutcome> {
        let run = bundle.run;
        let now_ms = now_epoch_ms();
        let approval_expires_at_ms = now_ms.saturating_add(bundle.approval_ttl_ms as i64);
        let selected = &run.plan.candidates[run.plan.selected_index];
        let plan_id = Uuid::new_v4().to_string();
        let mut step_outcomes = std::collections::HashMap::<&str, &StepResult>::new();
        for result in &run.step_results {
            step_outcomes.insert(result.step_id.as_str(), result);
        }

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO goals (id, description, status, dedupe_key) VALUES (?1, ?2, ?3, ?4)",
            params![
                run.goal.id,
                run.goal.description,
                run.goal.status.as_str(),
                run.goal.dedupe_key
            ],
        )?;
        tx.execute(
            "UPDATE goals SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![run.goal.status.as_str(), run.goal.id],
        )?;
        tx.execute(
            "INSERT INTO run_plans (id, goal_id, intent, selected_candidate_id, selected_score)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                plan_id,
                run.goal.id,
                format!("{:?}", run.plan.intent),
                selected.id,
                selected.score
            ],
        )?;

        for step in &selected.steps {
            let outcome = step_outcomes.get(step.id.as_str());
            let status = if outcome.is_some() {
                "executed"
            } else if run
                .pending_approval
                .as_ref()
                .map(|pending| pending.tool_name.as_str())
                == Some(step.tool_name.as_str())
            {
                "blocked_pending_approval"
            } else {
                "skipped"
            };
            let output = outcome
                .map(|item| item.output.as_str())
                .unwrap_or_default()
                .to_string();
            tx.execute(
                "INSERT INTO run_steps
                 (id, goal_id, plan_id, step_id, tool_name, permission, input, status, output)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    Uuid::new_v4().to_string(),
                    run.goal.id,
                    plan_id,
                    step.id,
                    step.tool_name,
                    step.permission.as_str(),
                    step.input,
                    status,
                    output
                ],
            )?;
        }

        for trace in &run.traces {
            tx.execute(
                "INSERT INTO trace_events (goal_id, event_type, detail) VALUES (?1, ?2, ?3)",
                params![trace.goal_id, trace.event_type, trace.detail],
            )?;
        }

        let approval_id = persist_pending_approval(
            &tx,
            &run.goal.id,
            run.pending_approval.as_ref(),
            bundle.source,
            bundle.requested_by,
            approval_expires_at_ms,
        )?;

        tx.execute(
            "INSERT INTO episodic_memories (goal_id, summary, source)
             VALUES (?1, ?2, ?3)",
            params![run.goal.id, run.reflection, bundle.source],
        )?;
        tx.commit()?;

        Ok(RunPersistenceOutcome { approval_id })
    }

    pub fn find_goal_by_dedupe_key(&self, dedupe_key: &str) -> Result<Option<StoredGoal>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, description, status, dedupe_key
             FROM goals
             WHERE dedupe_key = ?1",
        )?;
        let mut rows = stmt.query(params![dedupe_key])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(StoredGoal {
                id: row.get(0)?,
                description: row.get(1)?,
                status: row.get(2)?,
                dedupe_key: row.get(3)?,
            }));
        }
        Ok(None)
    }

    pub fn update_goal_status(&self, goal_id: &str, status: GoalStatus) -> Result<()> {
        self.conn.execute(
            "UPDATE goals SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![status.as_str(), goal_id],
        )?;
        Ok(())
    }

    pub fn add_trace_event(&self, event: &TraceEvent) -> Result<()> {
        self.conn.execute(
            "INSERT INTO trace_events (goal_id, event_type, detail) VALUES (?1, ?2, ?3)",
            params![event.goal_id, event.event_type, event.detail],
        )?;
        Ok(())
    }

    pub fn get_goal(&self, goal_id: &str) -> Result<Option<StoredGoal>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, description, status, dedupe_key FROM goals WHERE id = ?1")?;
        let mut rows = stmt.query(params![goal_id])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(StoredGoal {
                id: row.get(0)?,
                description: row.get(1)?,
                status: row.get(2)?,
                dedupe_key: row.get(3)?,
            }));
        }
        Ok(None)
    }

    pub fn list_goals(&self, limit: usize) -> Result<Vec<StoredGoal>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, description, status, dedupe_key
             FROM goals
             ORDER BY updated_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(StoredGoal {
                id: row.get(0)?,
                description: row.get(1)?,
                status: row.get(2)?,
                dedupe_key: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_traces(&self, goal_id: &str) -> Result<Vec<TraceEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT goal_id, event_type, detail
             FROM trace_events
             WHERE goal_id = ?1
             -- insertion order currently models execution order for the goal timeline
             ORDER BY id ASC",
        )?;

        let rows = stmt.query_map(params![goal_id], |row| {
            Ok(TraceEvent {
                goal_id: row.get(0)?,
                event_type: row.get(1)?,
                detail: row.get(2)?,
            })
        })?;

        let traces = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(traces)
    }

    pub fn search_traces(&self, pattern: &str, limit: usize) -> Result<Vec<TraceEvent>> {
        let like = format!("%{}%", pattern);
        let mut stmt = self.conn.prepare(
            "SELECT goal_id, event_type, detail
             FROM trace_events
             WHERE detail LIKE ?1 OR event_type LIKE ?1
             ORDER BY id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![like, limit as i64], |row| {
            Ok(TraceEvent {
                goal_id: row.get(0)?,
                event_type: row.get(1)?,
                detail: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_recent_traces(&self, limit: usize) -> Result<Vec<TraceEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT goal_id, event_type, detail
             FROM trace_events
             ORDER BY id DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(TraceEvent {
                goal_id: row.get(0)?,
                event_type: row.get(1)?,
                detail: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn count_plans_for_goal(&self, goal_id: &str) -> Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(1) FROM run_plans WHERE goal_id = ?1",
            params![goal_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    pub fn count_steps_for_goal(&self, goal_id: &str) -> Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(1) FROM run_steps WHERE goal_id = ?1",
            params![goal_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    pub fn mark_blocked_step_executed_for_goal(
        &self,
        goal_id: &str,
        tool_name: &str,
        output: &str,
    ) -> Result<usize> {
        let changed = self.conn.execute(
            "UPDATE run_steps
             SET status = 'executed_after_approval', output = ?1
             WHERE id = (
               SELECT id
               FROM run_steps
               WHERE goal_id = ?2
                 AND tool_name = ?3
                 AND status = 'blocked_pending_approval'
               ORDER BY created_at DESC
               LIMIT 1
             )",
            params![output, goal_id, tool_name],
        )?;
        Ok(changed)
    }

    pub fn count_active_goals(&self) -> Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(1)
             FROM goals
             WHERE status IN ('pending', 'planning', 'executing')",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    pub fn create_approval_request(
        &self,
        tool_name: &str,
        capability: &str,
        input: &str,
        requested_by: Option<&str>,
        ttl_ms: u64,
    ) -> Result<ApprovalRecord> {
        self.create_approval_request_for_goal(
            None,
            tool_name,
            capability,
            input,
            requested_by,
            ttl_ms,
        )
    }

    pub fn create_approval_request_for_goal(
        &self,
        goal_id: Option<&str>,
        tool_name: &str,
        capability: &str,
        input: &str,
        requested_by: Option<&str>,
        ttl_ms: u64,
    ) -> Result<ApprovalRecord> {
        let now_ms = now_epoch_ms();
        let expires_at_ms = now_ms.saturating_add(ttl_ms as i64);
        let id = Uuid::new_v4().to_string();
        let nonce = Uuid::new_v4().to_string();
        let record = ApprovalRecord {
            id: id.clone(),
            nonce: nonce.clone(),
            goal_id: goal_id.map(std::string::ToString::to_string),
            tool_name: tool_name.to_string(),
            capability: capability.to_string(),
            input: input.to_string(),
            status: "pending".to_string(),
            requested_by: requested_by.map(std::string::ToString::to_string),
            resolved_by: None,
            expires_at_ms,
            decision_reason: None,
        };
        self.conn.execute(
            "INSERT INTO approval_requests
             (id, nonce, goal_id, tool_name, capability, input, status, requested_by, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                record.id,
                record.nonce,
                record.goal_id,
                record.tool_name,
                record.capability,
                record.input,
                record.status,
                record.requested_by,
                record.expires_at_ms
            ],
        )?;
        Ok(record)
    }

    pub fn get_approval_request(&self, approval_id: &str) -> Result<Option<ApprovalRecord>> {
        self.expire_pending_approvals(now_epoch_ms())?;
        let mut stmt = self.conn.prepare(
            "SELECT id, nonce, goal_id, tool_name, capability, input, status, requested_by, resolved_by, expires_at_ms, decision_reason
             FROM approval_requests
             WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![approval_id])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(ApprovalRecord {
                id: row.get(0)?,
                nonce: row.get(1)?,
                goal_id: row.get(2)?,
                tool_name: row.get(3)?,
                capability: row.get(4)?,
                input: row.get(5)?,
                status: row.get(6)?,
                requested_by: row.get(7)?,
                resolved_by: row.get(8)?,
                expires_at_ms: row.get(9)?,
                decision_reason: row.get(10)?,
            }));
        }
        Ok(None)
    }

    pub fn list_pending_approvals(&self) -> Result<Vec<ApprovalRecord>> {
        self.expire_pending_approvals(now_epoch_ms())?;
        let mut stmt = self.conn.prepare(
            "SELECT id, nonce, goal_id, tool_name, capability, input, status, requested_by, resolved_by, expires_at_ms, decision_reason
             FROM approval_requests
             WHERE status = 'pending'
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ApprovalRecord {
                id: row.get(0)?,
                nonce: row.get(1)?,
                goal_id: row.get(2)?,
                tool_name: row.get(3)?,
                capability: row.get(4)?,
                input: row.get(5)?,
                status: row.get(6)?,
                requested_by: row.get(7)?,
                resolved_by: row.get(8)?,
                expires_at_ms: row.get(9)?,
                decision_reason: row.get(10)?,
            })
        })?;
        let approvals = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(approvals)
    }

    pub fn resolve_approval_request(
        &self,
        approval_id: &str,
        approved: bool,
        resolved_by: Option<&str>,
        reason: Option<&str>,
    ) -> Result<bool> {
        self.expire_pending_approvals(now_epoch_ms())?;
        let status = if approved { "approved" } else { "denied" };
        let rows_changed = self.conn.execute(
            "UPDATE approval_requests
             SET status = ?1, resolved_by = ?2, decision_reason = ?3, resolved_at = CURRENT_TIMESTAMP
             WHERE id = ?4 AND status = 'pending'",
            params![status, resolved_by, reason, approval_id],
        )?;
        Ok(rows_changed > 0)
    }

    pub fn approval_has_tool_run(&self, approval_id: &str) -> Result<bool> {
        let mut stmt = self
            .conn
            .prepare("SELECT 1 FROM tool_runs WHERE approval_id = ?1 LIMIT 1")?;
        let mut rows = stmt.query(params![approval_id])?;
        Ok(rows.next()?.is_some())
    }

    pub fn record_tool_run(
        &self,
        approval_id: Option<&str>,
        tool_name: &str,
        status: &str,
        output: &str,
    ) -> Result<ToolRunRecord> {
        let record = ToolRunRecord {
            id: Uuid::new_v4().to_string(),
            approval_id: approval_id.map(std::string::ToString::to_string),
            tool_name: tool_name.to_string(),
            status: status.to_string(),
            output: output.to_string(),
        };
        self.conn.execute(
            "INSERT INTO tool_runs (id, approval_id, tool_name, status, output)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                record.id,
                record.approval_id,
                record.tool_name,
                record.status,
                record.output
            ],
        )?;
        Ok(record)
    }

    pub fn expire_pending_approvals(&self, now_ms: i64) -> Result<usize> {
        let changed = self.conn.execute(
            "UPDATE approval_requests
             SET status = 'expired', resolved_at = CURRENT_TIMESTAMP
             WHERE status = 'pending' AND COALESCE(expires_at_ms, 0) <= ?1",
            params![now_ms],
        )?;
        Ok(changed)
    }

    pub fn upsert_semantic_fact(
        &self,
        namespace: &str,
        fact_key: &str,
        fact_value: &str,
        source: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO semantic_facts (namespace, fact_key, fact_value, source)
             VALUES (?1, ?2, ?3, ?4)",
            params![namespace, fact_key, fact_value, source],
        )?;
        Ok(())
    }

    pub fn add_procedural_strategy(
        &self,
        strategy_name: &str,
        strategy_body: &str,
        confidence: f64,
        source: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO procedural_strategies (strategy_name, strategy_body, confidence, source)
             VALUES (?1, ?2, ?3, ?4)",
            params![strategy_name, strategy_body, confidence, source],
        )?;
        Ok(())
    }

    pub fn add_episodic_memory(&self, goal_id: &str, summary: &str, source: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO episodic_memories (goal_id, summary, source)
             VALUES (?1, ?2, ?3)",
            params![goal_id, summary, source],
        )?;
        Ok(())
    }

    pub fn list_episodic_memory(&self, limit: usize) -> Result<Vec<EpisodicMemoryRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, goal_id, summary, source
             FROM episodic_memories
             ORDER BY id DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(EpisodicMemoryRecord {
                id: row.get(0)?,
                goal_id: row.get(1)?,
                summary: row.get(2)?,
                source: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // Backup uses SQLite VACUUM INTO semantics via ATTACH-compatible copy.
    // Closing/re-opening the connection avoids file-lock surprises on active writers.
    pub fn backup_to(&self, destination: &Path) -> Result<()> {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&self.db_path, destination).with_context(|| {
            format!(
                "failed to copy database from {} to {}",
                self.db_path.display(),
                destination.display()
            )
        })?;
        Ok(())
    }

    pub fn restore_from(&mut self, source: &Path) -> Result<()> {
        if !source.exists() {
            bail!("restore source does not exist: {}", source.display());
        }
        std::fs::copy(source, &self.db_path).with_context(|| {
            format!(
                "failed to restore database from {} to {}",
                source.display(),
                self.db_path.display()
            )
        })?;
        self.conn = Connection::open(&self.db_path)?;
        self.migrate()?;
        Ok(())
    }
}

fn now_epoch_ms() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    now.as_millis() as i64
}

fn persist_pending_approval(
    tx: &rusqlite::Transaction<'_>,
    goal_id: &str,
    pending: Option<&PendingApprovalAction>,
    source: &str,
    requested_by: Option<&str>,
    expires_at_ms: i64,
) -> Result<Option<String>> {
    let Some(pending) = pending else {
        return Ok(None);
    };
    let approval_id = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO approval_requests
         (id, nonce, goal_id, tool_name, capability, input, status, requested_by, expires_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)",
        params![
            approval_id,
            nonce,
            goal_id,
            pending.tool_name,
            pending.capability,
            pending.input.clone().unwrap_or_default(),
            requested_by.or(Some(source)),
            expires_at_ms
        ],
    )?;
    tx.execute(
        "INSERT INTO trace_events (goal_id, event_type, detail) VALUES (?1, 'approval_queued', ?2)",
        params![
            goal_id,
            format!("approval_id={} tool={}", approval_id, pending.tool_name)
        ],
    )?;
    Ok(Some(approval_id))
}
