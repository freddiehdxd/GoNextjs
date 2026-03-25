# Cron Jobs Per App — Design Spec

**Date:** 2026-03-25
**Status:** Approved

---

## Overview

Add per-app (and server-wide) cron job scheduling to the panel. Each job can run an arbitrary shell command or trigger a lifecycle action (restart/deploy) on a schedule. Jobs are stored in PostgreSQL and executed by an in-process Go scheduler.

---

## Data Model

### `cron_jobs` table

```sql
CREATE TABLE cron_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID REFERENCES apps(id) ON DELETE CASCADE,  -- NULL = server-wide
  name        TEXT NOT NULL,
  schedule    TEXT NOT NULL,        -- 5-field cron expression e.g. "0 * * * *"
  command     TEXT,                 -- shell command, OR NULL if lifecycle action
  action      TEXT,                 -- "restart" | "deploy" | NULL if command
  enabled     BOOLEAN NOT NULL DEFAULT true,
  max_runtime INTEGER NOT NULL DEFAULT 300,  -- seconds; 0 = no limit
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- enforce mutual exclusivity at the DB level
  CHECK ((command IS NULL) != (action IS NULL)),
  UNIQUE (app_id, name)  -- requires PostgreSQL 15+ for NULLS NOT DISTINCT;
                         -- for pg14 compat use a partial unique index instead
);
```

### `cron_runs` table

```sql
CREATE TABLE cron_runs (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  timeout_at  TIMESTAMPTZ,          -- started_at + max_runtime, set at dispatch
  status      TEXT NOT NULL DEFAULT 'running',
  exit_code   INTEGER,
  output      TEXT NOT NULL DEFAULT ''  -- truncated to last 64KB in handler
);
```

**Status values:** `running | success | error | timeout | missed`

### Retention

On each new run insertion, the handler first checks the count and only prunes if it exceeds 100 (avoiding a DELETE on every single insert for high-frequency jobs):

```sql
-- Only run if count > 100
DELETE FROM cron_runs WHERE job_id = $1 AND id NOT IN (
  SELECT id FROM cron_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 100
)
```

---

## New Dependency

`robfig/cron/v3` is added to `go.mod`. Only the parser is used (not the full scheduler). License: MIT. No transitive dependencies of concern. The parser handles all cron edge cases (day-of-week/day-of-month interaction, leap years, etc.) that a hand-rolled implementation would need to cover.

---

## Deploy Action — Service Extraction

The `"deploy"` action cannot call `AppsHandler` directly — it is an HTTP handler that writes to `http.ResponseWriter`. Instead, the deploy logic currently in `AppsHandler` is extracted into a new `services.AppDeployer` (or a standalone function in the `services` package) that accepts an `App` record and an `Executor`. Both the HTTP handler and the cron scheduler call this function. The scheduler performs a DB lookup to resolve the app record (name, repo, branch, port, env vars) before invoking the deploy function.

The extracted function **must** write the `.env` file before invoking `deploy_next_app.sh`, exactly as `AppsHandler.Action` does for the `rebuild` case. Omitting this would cause cron-triggered deploys to run with a stale or missing env file.

---

## Command Jobs — Security Model

`command` jobs run arbitrary shell strings. This panel is single-tenant (admin-only access). The security model is:

- **Shell:** `/bin/sh -c "<command>"`
- **Working directory:** the app's deploy directory (`/var/www/<appname>` or equivalent, resolved from the app record)
- **Environment:** the app's `env_vars` from the DB, plus a minimal `PATH`
- **User:** the same OS user that runs the panel process (no additional sandboxing)
- **No allowlist:** unlike `Executor` (which only runs whitelisted scripts), command jobs are unrestricted. This is intentional — the panel operator is the only user who can create jobs.

This decision is recorded here. If multi-tenant support is ever added, command jobs must be revisited.

---

## Scheduler (Go)

A `CronScheduler` service starts a single goroutine on panel boot and ticks every 60 seconds.

### Startup — orphaned run cleanup

On startup, before the first tick, the scheduler:
1. Marks any `cron_runs` row with `status = running` and `timeout_at < NOW()` as `timeout`
2. Marks any `cron_runs` row with `status = running` and `timeout_at IS NULL OR timeout_at > NOW()` as `error` with `output = "panel restarted mid-run"`

This ensures no runs are permanently stuck in `running` state after a crash.

### Tick loop

1. Query all enabled jobs where `next_run_at <= NOW()`
2. For each job, **immediately update** `last_run_at = NOW()` and `next_run_at = sched.Next(NOW())` in the DB (optimistic advance, before dispatch). This prevents double-firing if the panel restarts between tick and job completion.
3. Dispatch each job to the bounded worker pool (max 10 concurrent)
4. Insert `cron_runs` row with `status = running`, `timeout_at = NOW() + max_runtime`

**Worker pool overflow:** if the pool is full (all 10 slots busy), the job is skipped for this tick. `next_run_at` was already advanced in step 2, so the job fires on the next natural schedule tick — it is not inserted as `missed`. If a job is skipped for 3 or more consecutive ticks due to pool saturation, a `missed` run is inserted to surface the problem. This bound prevents silent starvation for long-running jobs.

### Missed run policy

On each tick, if a job's `next_run_at` is in the past at tick time (i.e., the panel was offline):
1. Insert a `cron_runs` row with `status = missed`, `started_at = next_run_at`, `finished_at = NOW()`, `output = "skipped: panel was offline"`
2. Advance `next_run_at` to the next future fire time without executing the job
3. The 100-run cap applies to missed entries

### Execution

**Command jobs:** `exec.CommandContext` with `context.WithTimeout(max_runtime)`. Shell: `/bin/sh -c "<command>"`. Working dir: app deploy directory (resolved from app record). For server-wide jobs (`app_id = NULL`), working dir falls back to the panel process's working directory. Stdout and stderr combined, buffered, capped at 64KB (last 64KB kept if exceeded). Exit code captured on completion. On timeout, status set to `timeout`.

**Action jobs — restart:** calls `pm2.Restart(appName)` directly.

**Action jobs — deploy:** calls the extracted `services.DeployApp(app, executor)` function after resolving the app record from DB.

**On completion (worker goroutine):** update `cron_runs` — set `finished_at`, `status`, `exit_code`, `output`.

### Cron expression parsing

```go
parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
sched, err := parser.Parse(expr)
nextRun := sched.Next(time.Now())
```

### Audit log

Scheduler-dispatched runs write a single row directly to `audit_log` **at completion** (not at dispatch), consistent with how the HTTP middleware works. Fields:
- `username = "scheduler"`
- `ip = ""` (no IP for scheduler; empty string satisfies NOT NULL)
- `method = "CRON"`
- `path = "/cron/jobs/<id>"`
- `status_code` = 200 (success), 500 (error/timeout/missed)
- `body = '{"job_id":"<uuid>"}'`

This makes scheduler activity visible in the existing audit log view.

### Shutdown

The scheduler goroutine listens on `context.Done()` and exits. On shutdown, any `cron_runs` rows still in `running` state are immediately marked `error` with `output = "panel shutting down"`. (The startup orphan-cleanup also handles any rows that weren't written during a hard crash.)

---

## API

All routes require JWT auth and are recorded by the audit log middleware.

```
GET    /api/cron/jobs                          # list all jobs (optional ?app_id= filter)
POST   /api/cron/jobs                          # create job
GET    /api/cron/jobs/:id                      # get single job
PUT    /api/cron/jobs/:id                      # update job
DELETE /api/cron/jobs/:id                      # delete job
POST   /api/cron/jobs/:id/toggle               # enable / disable
POST   /api/cron/jobs/:id/run                  # trigger immediate run (ignores schedule)
GET    /api/cron/jobs/:id/runs                 # run history (last 100)
GET    /api/cron/jobs/:id/runs/:run_id/output  # full output for a single run
```

### Create / update payload

```json
{
  "app_id": "uuid-or-null",
  "name": "Nightly cleanup",
  "schedule": "0 2 * * *",
  "command": "node scripts/cleanup.js",
  "action": null,
  "max_runtime": 120,
  "enabled": true
}
```

### Validation

- Exactly one of `command` / `action` must be set (also enforced by DB CHECK constraint)
- `action` must be `"restart"` or `"deploy"` if present
- `schedule` must parse cleanly via `robfig/cron/v3`
- `max_runtime` must be >= 0

### Concurrent execution guard

`POST /api/cron/jobs/:id/run` checks for an existing `cron_runs` row with `status = running` for the job. If found, returns `409 Conflict` with `{"error": "job is already running"}`. The scheduler's worker pool enforces the same — a job already in-flight is not re-dispatched.

---

## Frontend

### App cron tab

A new `cron` tab is added to `AppDetail.tsx` (alongside overview, logs, configuration, deployments). The `Tab` union type must be extended: `'overview' | 'logs' | 'configuration' | 'deployments' | 'cron'`.

**Layout:**
- Header: "Cron Jobs" + "Add Job" button
- Table: name, schedule (human-readable + raw expression), last run (relative time + status badge), next run, enabled toggle, run now / edit / delete actions
- Clicking a job row expands an inline run history panel: last 100 runs as a compact list with timestamp, status badge, duration, output preview
- Clicking a run opens a modal with full output
- Run history panel uses its own `setInterval` polling `/api/cron/jobs/:id/runs` every 5 seconds — this is separate from the existing app-level interval and must not be conflated with it

### Server-wide jobs

A top-level `/cron` page linked from the nav shows jobs where `app_id = null`, same layout as the app tab.

### Add / Edit modal

Fields:
- **Name** — text input
- **Schedule** — preset dropdown (`Every 5 min` → `*/5 * * * *`, `Hourly` → `0 * * * *`, `Daily at midnight` → `0 0 * * *`, `Weekly` → `0 0 * * 0`, `Monthly` → `0 0 1 * *`) with an "Advanced" toggle that reveals a raw cron expression input with live validation
- **Type** — toggle: "Command" (textarea) vs "App Action" (dropdown: Restart / Deploy)
- **Max runtime** — number input in seconds, default 300
- **Enabled** — checkbox

### StatusBadge extension

The existing `StatusBadge` component is **extended** (not just reused) to handle cron-specific statuses. New mappings added:

| Status    | Color         |
|-----------|---------------|
| success   | green         |
| error     | red           |
| running   | animated blue |
| timeout   | orange        |
| missed    | gray          |
