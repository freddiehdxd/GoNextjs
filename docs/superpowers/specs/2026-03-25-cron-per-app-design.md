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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Exactly one of `command` or `action` is set per job. This is enforced in the handler, not via DB constraint.

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

On each new run insertion, the handler prunes runs beyond the most recent 100 for that job:

```sql
DELETE FROM cron_runs WHERE job_id = $1 AND id NOT IN (
  SELECT id FROM cron_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 100
)
```

---

## Scheduler (Go)

A `CronScheduler` service starts a single goroutine on panel boot and ticks every 60 seconds.

### Tick loop

1. Query all enabled jobs where `next_run_at <= NOW()`
2. Dispatch each to a bounded worker pool (max 10 concurrent jobs)
3. Update `last_run_at`, compute new `next_run_at` via `robfig/cron/v3` parser
4. Insert `cron_runs` row with `status = running`, `timeout_at = NOW() + max_runtime`

### Execution

**Command jobs:** `exec.CommandContext` with `context.WithTimeout(max_runtime)`. Stdout and stderr are combined, buffered, and capped at 64KB. Exit code is captured on completion.

**Action jobs:** calls existing `PM2.Restart(appName)` or the existing deploy logic in `AppsHandler`. Result is recorded as output.

**Timeout:** when the context cancels, status is set to `timeout` and `finished_at` is recorded.

### Cron expression parsing

Uses `robfig/cron/v3`'s parser only (not the full scheduler):

```go
parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
sched, err := parser.Parse(expr)
nextRun := sched.Next(time.Now())
```

This handles all edge cases (day-of-week/day-of-month interaction, leap years, etc.).

### Missed run policy

On startup and every tick, if a job's `next_run_at` is in the past, the scheduler:

1. Inserts a `cron_runs` row with `status = missed`, `started_at = next_run_at`, `finished_at = NOW()`, `output = "skipped: panel was offline"`
2. Advances `next_run_at` to the next future fire time without executing the job
3. The 100-run cap applies to missed entries

### Shutdown

The scheduler goroutine listens on `context.Done()` and exits cleanly. In-flight jobs finish naturally via their own timeouts.

---

## API

All routes require JWT auth and are recorded by the audit log middleware.

```
GET    /api/cron/jobs                  # list all jobs (optional ?app_id= filter)
POST   /api/cron/jobs                  # create job
GET    /api/cron/jobs/:id              # get single job
PUT    /api/cron/jobs/:id              # update job
DELETE /api/cron/jobs/:id              # delete job
POST   /api/cron/jobs/:id/toggle       # enable / disable
POST   /api/cron/jobs/:id/run          # trigger immediate run (ignores schedule)
GET    /api/cron/jobs/:id/runs         # run history (last 100)
GET    /api/cron/runs/:run_id/output   # full output for a single run
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

- Exactly one of `command` / `action` must be set
- `action` must be `"restart"` or `"deploy"` if present
- `schedule` must parse cleanly via `robfig/cron/v3`
- `max_runtime` must be >= 0

---

## Frontend

### App cron tab

A new `cron` tab is added to `AppDetail.tsx` (alongside overview, logs, configuration, deployments).

**Layout:**
- Header: "Cron Jobs" + "Add Job" button
- Table: name, schedule (human-readable + raw expression), last run (relative time + status badge), next run, enabled toggle, run now / edit / delete actions
- Clicking a job row expands an inline run history panel: last 100 runs as a compact list with timestamp, status badge, duration, output preview
- Clicking a run opens a modal with full output

### Server-wide jobs

A top-level `/cron` page linked from the nav shows jobs where `app_id = null`, same layout as the app tab.

### Add / Edit modal

Fields:
- **Name** — text input
- **Schedule** — preset dropdown (`Every 5 min` → `*/5 * * * *`, `Hourly` → `0 * * * *`, `Daily at midnight` → `0 0 * * *`, `Weekly` → `0 0 * * 0`, `Monthly` → `0 0 1 * *`) with an "Advanced" toggle that reveals a raw cron expression input with live validation
- **Type** — toggle: "Command" (textarea) vs "App Action" (dropdown: Restart / Deploy)
- **Max runtime** — number input in seconds, default 300
- **Enabled** — checkbox

### Status badges

Reuse existing `StatusBadge` component:

| Status    | Color    |
|-----------|----------|
| success   | green    |
| error     | red      |
| running   | animated blue |
| timeout   | orange   |
| missed    | gray     |
