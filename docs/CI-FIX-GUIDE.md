# CI Fix Guide — Worker OOM Crashes

## Problem
GitHub CI runners (Node 22, ~7GB RAM) crash with "Worker exited unexpectedly" 
when running the full 4500+ test suite. This is a memory issue, not a code issue.

## Root Cause
- 150+ test files with heavy vi.mock() setups
- Each test file mocks the entire agent module tree
- Vitest runs multiple workers in parallel, each consuming ~1-2GB
- Combined memory exceeds CI runner limits

## Solutions (pick one or combine)

### Option 1: Shard CI into multiple jobs
Split tests across 4 parallel jobs in .github/workflows/ci.yml:
- Job 1: tests/core*.ts, tests/provider*.ts (fast, small)
- Job 2: tests/agent*.ts, tests/deliberation*.ts (medium)
- Job 3: tests/skill*.ts, tests/builtin*.ts (large)
- Job 4: tests/gateway*.ts, tests/streaming*.ts (needs server)

### Option 2: Reduce worker concurrency
Add to vitest.config.ts: { maxConcurrency: 2, maxWorkers: 2 }

### Option 3: Use --poolOptions.threads.maxThreads=2
In CI workflow: npx vitest run --poolOptions.threads.maxThreads=2

## Files to check
- .github/workflows/ci.yml — CI config
- vitest.config.ts — test runner config
- tests/ — 150+ test files

## What's passing locally
All tests pass locally (224/224 in our subset). The OOM only happens
in CI where multiple test files run concurrently.
