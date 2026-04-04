-- TITAN Storage: Initial Schema
-- All tables for Command Post persistence

CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER NOT NULL DEFAULT 5,
    schedule TEXT,
    budget_limit NUMERIC,
    total_cost NUMERIC NOT NULL DEFAULT 0,
    progress NUMERIC NOT NULL DEFAULT 0,
    parent_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    tags JSONB DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT NOT NULL,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    completed_at TIMESTAMPTZ,
    retries INTEGER NOT NULL DEFAULT 0,
    depends_on JSONB DEFAULT '[]',
    trigger JSONB,
    PRIMARY KEY (id, goal_id)
);

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    last_heartbeat TIMESTAMPTZ,
    current_task_id TEXT,
    total_tasks_completed INTEGER NOT NULL DEFAULT 0,
    total_cost_usd NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reports_to TEXT,
    role TEXT NOT NULL DEFAULT 'general',
    title TEXT,
    adapter_type TEXT,
    adapter_config JSONB,
    schedule TEXT
);

CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee_agent_id TEXT,
    created_by_agent_id TEXT,
    created_by_user TEXT,
    goal_id TEXT,
    parent_id TEXT,
    checkout_run_id TEXT,
    issue_number SERIAL,
    identifier TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_agent_id TEXT,
    author_user TEXT,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    linked_issue_ids JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    issue_id TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    tools_used JSONB DEFAULT '[]',
    token_usage JSONB,
    error TEXT
);

CREATE TABLE IF NOT EXISTS checkouts (
    subtask_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    checked_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'locked'
);

CREATE TABLE IF NOT EXISTS budget_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_target_id TEXT,
    period TEXT NOT NULL,
    limit_usd NUMERIC NOT NULL,
    warning_threshold_percent INTEGER NOT NULL DEFAULT 80,
    action TEXT NOT NULL DEFAULT 'warn',
    current_spend NUMERIC NOT NULL DEFAULT 0,
    period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    type TEXT NOT NULL,
    agent_id TEXT,
    goal_id TEXT,
    message TEXT NOT NULL,
    metadata JSONB
);

CREATE TABLE IF NOT EXISTS budget_reservations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    goal_id TEXT,
    run_id TEXT NOT NULL,
    estimated_usd NUMERIC NOT NULL,
    actual_usd NUMERIC,
    status TEXT NOT NULL DEFAULT 'reserved',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subtasks_goal ON subtasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_agent_id);
CREATE INDEX IF NOT EXISTS idx_issues_goal ON issues(goal_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity(type);
CREATE INDEX IF NOT EXISTS idx_checkouts_status ON checkouts(status);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_status ON budget_reservations(status);
