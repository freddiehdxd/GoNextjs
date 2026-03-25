# Cron Jobs Per App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-app and server-wide cron job scheduling to the panel — stored in PostgreSQL, executed by an in-process Go scheduler, managed via a new API + frontend UI.

**Architecture:** A `CronScheduler` service goroutine ticks every 60 seconds, queries due jobs, and dispatches them to a bounded worker pool (max 10 concurrent). Arbitrary shell commands run via `/bin/sh -c`, lifecycle actions call existing services. A `CronHandler` exposes a REST API for CRUD. The frontend adds a `cron` tab to `AppDetail` and a top-level `/cron` page.

**Tech Stack:** Go 1.22, pgx/v5, `robfig/cron/v3` (parser only), React + TypeScript + Tailwind CSS, Vite.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/internal/services/db.go` | Modify | Add migration 4: `cron_jobs` + `cron_runs` tables |
| `backend/go.mod` / `go.sum` | Modify | Add `robfig/cron/v3` dependency |
| `backend/internal/services/deploy.go` | **Create** | Standalone `WriteEnvFile()` + `DeployApp()` functions |
| `backend/internal/handlers/apps.go` | Modify | Replace `h.writeEnvFile()` calls with `services.WriteEnvFile()` |
| `backend/internal/services/cron.go` | **Create** | `CronScheduler` struct: tick loop, worker pool, execution |
| `backend/internal/services/cron_test.go` | **Create** | Unit tests for `ParseSchedule`, `WriteEnvFile` |
| `backend/internal/handlers/cron.go` | **Create** | `CronHandler` with 9 HTTP routes |
| `backend/internal/handlers/cron_test.go` | **Create** | Handler validation tests (no DB needed) |
| `backend/main.go` | Modify | Wire `CronScheduler` + `CronHandler` + routes |
| `frontend/src/lib/api.ts` | Modify | Add `CronJob` + `CronRun` TypeScript interfaces |
| `frontend/src/components/StatusBadge.tsx` | Modify | Add cron statuses: success, error, timeout, missed |
| `frontend/src/pages/Cron.tsx` | **Create** | Server-wide cron page (`/cron`) |
| `frontend/src/pages/AppDetail.tsx` | Modify | Add `cron` tab with job table + run history |
| `frontend/src/App.tsx` | Modify | Add `/cron` route |
| `frontend/src/components/Nav.tsx` | Modify | Add Cron nav link |

---

## Task 1: DB Migration — Add cron tables

**Files:**
- Modify: `backend/internal/services/db.go`

The project uses PostgreSQL 17 (installed from official PG repo), so `NULLS NOT DISTINCT` is available. Append migration 4 to the existing `migrations` slice.

- [ ] **Step 1: Add migration to db.go**

Open `backend/internal/services/db.go`. Locate the `migrations` slice (around line 55). Append after the last `}` entry in the slice, before the closing `}`:

```go
{
    version:     4,
    description: "Add cron_jobs and cron_runs tables",
    sql: `
        CREATE TABLE IF NOT EXISTS cron_jobs (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            app_id      UUID REFERENCES apps(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            schedule    TEXT NOT NULL,
            command     TEXT,
            action      TEXT,
            enabled     BOOLEAN NOT NULL DEFAULT true,
            max_runtime INTEGER NOT NULL DEFAULT 300,
            last_run_at TIMESTAMPTZ,
            next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK ((command IS NULL) != (action IS NULL)),
            UNIQUE NULLS NOT DISTINCT (app_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_cron_jobs_app_id ON cron_jobs(app_id);
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at) WHERE enabled = true;

        CREATE TABLE IF NOT EXISTS cron_runs (
            id          BIGSERIAL PRIMARY KEY,
            job_id      UUID NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
            started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            timeout_at  TIMESTAMPTZ,
            status      TEXT NOT NULL DEFAULT 'running',
            exit_code   INTEGER,
            output      TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id);
    `,
},
```

- [ ] **Step 2: Build to verify no syntax errors**

```bash
cd backend && go build ./...
```
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/services/db.go
git commit -m "feat(cron): add cron_jobs and cron_runs DB migration"
```

---

## Task 2: Add robfig/cron/v3 Dependency

**Files:**
- Modify: `backend/go.mod`, `backend/go.sum`

- [ ] **Step 1: Add dependency**

```bash
cd backend && go get github.com/robfig/cron/v3@latest
```
Expected: `go: added github.com/robfig/cron/v3 vX.Y.Z`

- [ ] **Step 2: Verify build still works**

```bash
go build ./...
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend/go.mod backend/go.sum
git commit -m "feat(cron): add robfig/cron/v3 parser dependency"
```

---

## Task 3: Extract Deploy Helpers into services/deploy.go

**Files:**
- Create: `backend/internal/services/deploy.go`
- Modify: `backend/internal/handlers/apps.go`

The `writeEnvFile` method currently lives on `AppsHandler` and uses `h.cfg.AppsDir`. We extract it so the scheduler can call it without importing `handlers`.

- [ ] **Step 1: Write failing test first**

Create `backend/internal/services/deploy_test.go`:

```go
package services

import (
    "os"
    "path/filepath"
    "strings"
    "testing"
)

func TestWriteEnvFile_CreatesFile(t *testing.T) {
    dir := t.TempDir()
    appName := "myapp"
    envVars := map[string]string{
        "PORT": "3000",
        "NODE_ENV": "production",
    }

    err := WriteEnvFile(dir, appName, envVars)
    if err != nil {
        t.Fatalf("WriteEnvFile error: %v", err)
    }

    content, err := os.ReadFile(filepath.Join(dir, appName, ".env"))
    if err != nil {
        t.Fatalf("Read .env: %v", err)
    }

    got := string(content)
    if !strings.Contains(got, "PORT=3000") {
        t.Errorf("Expected PORT=3000 in .env, got:\n%s", got)
    }
    if !strings.Contains(got, "NODE_ENV=production") {
        t.Errorf("Expected NODE_ENV=production in .env, got:\n%s", got)
    }
}

func TestWriteEnvFile_RemovesFileWhenEmpty(t *testing.T) {
    dir := t.TempDir()
    appName := "myapp"

    // Create it first
    os.MkdirAll(filepath.Join(dir, appName), 0755)
    os.WriteFile(filepath.Join(dir, appName, ".env"), []byte("FOO=bar\n"), 0600)

    err := WriteEnvFile(dir, appName, map[string]string{})
    if err != nil {
        t.Fatalf("WriteEnvFile error: %v", err)
    }

    _, err = os.Stat(filepath.Join(dir, appName, ".env"))
    if !os.IsNotExist(err) {
        t.Error("Expected .env to be removed when envVars is empty")
    }
}

func TestWriteEnvFile_QuotesSpecialChars(t *testing.T) {
    dir := t.TempDir()
    err := WriteEnvFile(dir, "app", map[string]string{
        "DB_URL": "postgres://user:p@ss word@host/db",
    })
    if err != nil {
        t.Fatalf("WriteEnvFile error: %v", err)
    }
    content, _ := os.ReadFile(filepath.Join(dir, "app", ".env"))
    if !strings.Contains(string(content), `"`) {
        t.Errorf("Expected value with spaces to be quoted, got: %s", content)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && go test ./internal/services/... -run TestWriteEnvFile -v
```
Expected: `FAIL` — `WriteEnvFile` is undefined.

- [ ] **Step 3: Create backend/internal/services/deploy.go**

```go
package services

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"

    "panel-backend/internal/models"
)

// WriteEnvFile writes environment variables to {appsDir}/{appName}/.env.
// If envVars is empty, removes the .env file.
// This file is read by deploy/setup scripts and injected into ecosystem.config.js.
func WriteEnvFile(appsDir, appName string, envVars map[string]string) error {
    appDir := filepath.Join(appsDir, appName)
    if err := os.MkdirAll(appDir, 0755); err != nil {
        return fmt.Errorf("create app dir: %w", err)
    }

    envPath := filepath.Join(appDir, ".env")

    if len(envVars) == 0 {
        os.Remove(envPath) // best-effort
        return nil
    }

    var lines []string
    for k, v := range envVars {
        if strings.ContainsAny(v, " \t\n\"'\\$#") {
            v = `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
        }
        lines = append(lines, fmt.Sprintf("%s=%s", k, v))
    }

    content := strings.Join(lines, "\n") + "\n"
    return os.WriteFile(envPath, []byte(content), 0600)
}

// DeployApp writes the .env file and runs deploy_next_app.sh for the given app.
// Used by both the HTTP handler and the cron scheduler.
func DeployApp(app *models.App, exec *Executor, appsDir string) (*models.ExecResult, error) {
    WriteEnvFile(appsDir, app.Name, app.EnvVars) // best-effort; script also reads it
    return exec.RunScript("deploy_next_app.sh",
        app.Name, app.RepoURL, app.Branch,
        fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && go test ./internal/services/... -run TestWriteEnvFile -v
```
Expected: `PASS`.

- [ ] **Step 5: Update apps.go to use services.WriteEnvFile**

In `backend/internal/handlers/apps.go`:
1. Remove the private `writeEnvFile` method (lines ~822–851).
2. Replace every call to `h.writeEnvFile(...)` with `services.WriteEnvFile(h.cfg.AppsDir, ...)`.

There are 8 call sites. Example replacement:
```go
// Before:
h.writeEnvFile(app.Name, app.EnvVars)

// After:
services.WriteEnvFile(h.cfg.AppsDir, app.Name, app.EnvVars)
```

- [ ] **Step 6: Build and run existing tests**

```bash
cd backend && go build ./... && go test ./...
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/services/deploy.go \
        backend/internal/services/deploy_test.go \
        backend/internal/handlers/apps.go
git commit -m "feat(cron): extract WriteEnvFile/DeployApp into services/deploy.go"
```

---

## Task 4: CronScheduler Service

**Files:**
- Create: `backend/internal/services/cron.go`
- Create: `backend/internal/services/cron_test.go`

- [ ] **Step 1: Write failing tests**

Create `backend/internal/services/cron_test.go`:

```go
package services

import (
    "testing"
    "time"
)

func TestParseSchedule_ValidExpressions(t *testing.T) {
    cases := []string{
        "* * * * *",       // every minute
        "0 * * * *",       // hourly
        "0 0 * * *",       // daily
        "*/5 * * * *",     // every 5 min
        "0 0 * * 0",       // weekly sunday
        "0 0 1 * *",       // monthly
        "0 2 * * 1-5",     // weekdays at 2am
    }
    for _, expr := range cases {
        _, err := ParseSchedule(expr)
        if err != nil {
            t.Errorf("ParseSchedule(%q) should be valid, got error: %v", expr, err)
        }
    }
}

func TestParseSchedule_InvalidExpressions(t *testing.T) {
    cases := []string{
        "",
        "not a cron",
        "* * * *",      // only 4 fields
        "60 * * * *",   // minute out of range
        "* 25 * * *",   // hour out of range
    }
    for _, expr := range cases {
        _, err := ParseSchedule(expr)
        if err == nil {
            t.Errorf("ParseSchedule(%q) should be invalid, but got no error", expr)
        }
    }
}

func TestNextRunAfter_IsInFuture(t *testing.T) {
    sched, err := ParseSchedule("0 * * * *") // hourly
    if err != nil {
        t.Fatal(err)
    }
    now := time.Now()
    next := sched.Next(now)
    if !next.After(now) {
        t.Errorf("Next run %v should be after now %v", next, now)
    }
}

func TestNextRunAfter_Hourly(t *testing.T) {
    sched, _ := ParseSchedule("0 * * * *")
    // Start from a known time: 2026-01-01 10:30:00
    base := time.Date(2026, 1, 1, 10, 30, 0, 0, time.UTC)
    next := sched.Next(base)
    expected := time.Date(2026, 1, 1, 11, 0, 0, 0, time.UTC)
    if !next.Equal(expected) {
        t.Errorf("Expected next hourly after 10:30 to be 11:00, got %v", next)
    }
}

func TestNextRunAfter_LeapYear(t *testing.T) {
    // "0 0 29 2 *" = midnight on Feb 29 (leap day)
    sched, err := ParseSchedule("0 0 29 2 *")
    if err != nil {
        t.Fatal(err)
    }
    base := time.Date(2026, 2, 28, 12, 0, 0, 0, time.UTC) // 2026 is not a leap year
    next := sched.Next(base)
    // Next leap day is Feb 29, 2028
    if next.Year() != 2028 || next.Month() != 2 || next.Day() != 29 {
        t.Errorf("Expected next Feb 29 to be 2028-02-29, got %v", next)
    }
}

func TestTruncateOutput_Under64KB(t *testing.T) {
    input := []byte("hello world")
    result := truncateOutput(input)
    if string(result) != "hello world" {
        t.Errorf("Under 64KB should be unchanged, got %q", result)
    }
}

func TestTruncateOutput_Over64KB(t *testing.T) {
    // Create 100KB of data
    large := make([]byte, 100*1024)
    for i := range large {
        large[i] = 'x'
    }
    result := truncateOutput(large)
    if len(result) > cronMaxOutputBytes+100 {
        t.Errorf("Expected truncation to ~64KB, got %d bytes", len(result))
    }
    if string(result[:len("[output truncated")]) != "[output truncated" {
        t.Errorf("Expected truncation notice at start, got: %s", result[:50])
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && go test ./internal/services/... -run "TestParseSchedule|TestNextRunAfter|TestTruncateOutput" -v
```
Expected: `FAIL` — functions undefined.

- [ ] **Step 3: Create backend/internal/services/cron.go**

```go
package services

import (
    "bytes"
    "context"
    "fmt"
    "log"
    "os"
    "os/exec"
    "sync"
    "time"

    cron "github.com/robfig/cron/v3"
)

const (
    cronWorkerPoolSize = 10
    cronMaxOutputBytes = 64 * 1024 // 64KB
    cronPoolSkipLimit  = 3         // consecutive pool-full skips before "missed"
    cronTickInterval   = 60 * time.Second
)

// ParseSchedule parses a 5-field cron expression using robfig/cron/v3.
// Returns the parsed schedule or an error if the expression is invalid.
func ParseSchedule(expr string) (cron.Schedule, error) {
    p := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
    return p.Parse(expr)
}

// truncateOutput keeps the last cronMaxOutputBytes bytes of output.
// If truncated, a notice is prepended.
func truncateOutput(b []byte) []byte {
    if len(b) <= cronMaxOutputBytes {
        return b
    }
    tail := b[len(b)-cronMaxOutputBytes:]
    notice := []byte("[output truncated — showing last 64KB]\n")
    return append(notice, tail...)
}

// cronJob is a lightweight job record fetched by the scheduler.
type cronJob struct {
    ID         string
    AppID      *string
    AppName    string // resolved from DB join (empty if app_id IS NULL)
    RepoURL    string
    Branch     string
    Port       int
    MaxMemory  int
    EnvVars    map[string]string
    Name       string
    Schedule   string
    Command    *string
    Action     *string
    MaxRuntime int
    NextRunAt  time.Time
}

// CronScheduler runs cron jobs on a 60-second tick.
type CronScheduler struct {
    db      *DB
    pm2     *PM2
    exec    *Executor
    appsDir string

    mu        sync.Mutex
    inFlight  map[string]struct{} // job ID → in-flight sentinel
    skipCount map[string]int      // job ID → consecutive pool-full skip count
    pool      chan struct{}        // semaphore limiting concurrent workers

    cancel context.CancelFunc
}

// NewCronScheduler creates a scheduler. Call Start to begin ticking.
func NewCronScheduler(db *DB, pm2 *PM2, exec *Executor, appsDir string) *CronScheduler {
    return &CronScheduler{
        db:        db,
        pm2:       pm2,
        exec:      exec,
        appsDir:   appsDir,
        inFlight:  make(map[string]struct{}),
        skipCount: make(map[string]int),
        pool:      make(chan struct{}, cronWorkerPoolSize),
    }
}

// Start launches the scheduler goroutine. ctx is for the parent; the scheduler
// creates its own cancellable child context exposed via Stop.
func (s *CronScheduler) Start(ctx context.Context) {
    child, cancel := context.WithCancel(ctx)
    s.cancel = cancel
    go s.run(child)
}

// Stop halts the scheduler and marks any in-flight runs as errored.
func (s *CronScheduler) Stop() {
    if s.cancel != nil {
        s.cancel()
    }
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    s.db.Exec(ctx,
        `UPDATE cron_runs SET status='error', finished_at=NOW(), output='panel shutting down'
         WHERE status='running'`)
}

// IsRunning returns true if the given job ID has an active run.
func (s *CronScheduler) IsRunning(jobID string) bool {
    s.mu.Lock()
    defer s.mu.Unlock()
    _, ok := s.inFlight[jobID]
    return ok
}

// RunNow dispatches a job immediately, ignoring its schedule.
// Returns error if the job is already running or does not exist.
func (s *CronScheduler) RunNow(ctx context.Context, jobID string) error {
    if s.IsRunning(jobID) {
        return fmt.Errorf("job is already running")
    }

    job, err := s.fetchJob(ctx, jobID)
    if err != nil {
        return fmt.Errorf("fetch job: %w", err)
    }

    runID, err := s.insertRun(ctx, job)
    if err != nil {
        return fmt.Errorf("insert run: %w", err)
    }

    s.mu.Lock()
    s.inFlight[jobID] = struct{}{}
    s.mu.Unlock()

    go func() {
        defer func() {
            s.mu.Lock()
            delete(s.inFlight, jobID)
            s.mu.Unlock()
        }()
        s.executeJob(context.Background(), job, runID)
    }()

    return nil
}

func (s *CronScheduler) run(ctx context.Context) {
    s.cleanupOrphans(ctx)

    ticker := time.NewTicker(cronTickInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            s.tick(ctx)
        }
    }
}

func (s *CronScheduler) tick(ctx context.Context) {
    rows, err := s.db.Query(ctx, `
        SELECT
            j.id, j.app_id,
            COALESCE(a.name,'')      AS app_name,
            COALESCE(a.repo_url,'')  AS repo_url,
            COALESCE(a.branch,'')    AS branch,
            COALESCE(a.port,0)       AS port,
            COALESCE(a.max_memory,512) AS max_memory,
            COALESCE(a.env_vars,'{}') AS env_vars,
            j.name, j.schedule, j.command, j.action, j.max_runtime, j.next_run_at
        FROM cron_jobs j
        LEFT JOIN apps a ON a.id = j.app_id
        WHERE j.enabled = true AND j.next_run_at <= NOW()
    `)
    if err != nil {
        log.Printf("cron: query due jobs: %v", err)
        return
    }
    defer rows.Close()

    var jobs []cronJob
    for rows.Next() {
        var j cronJob
        var envJSON []byte
        if err := rows.Scan(
            &j.ID, &j.AppID,
            &j.AppName, &j.RepoURL, &j.Branch, &j.Port, &j.MaxMemory, &envJSON,
            &j.Name, &j.Schedule, &j.Command, &j.Action, &j.MaxRuntime, &j.NextRunAt,
        ); err != nil {
            log.Printf("cron: scan job: %v", err)
            continue
        }
        j.EnvVars = make(map[string]string)
        // best-effort JSON parse
        if len(envJSON) > 0 {
            var m map[string]string
            if jsonUnmarshal(envJSON, &m) == nil {
                j.EnvVars = m
            }
        }
        jobs = append(jobs, j)
    }
    rows.Close()

    now := time.Now()
    for _, job := range jobs {
        // Missed run: next_run_at was >2 min ago — panel was down
        if job.NextRunAt.Before(now.Add(-2 * time.Minute)) {
            s.recordMissed(ctx, job)
            s.advanceSchedule(ctx, job)
            continue
        }

        // Skip if already in-flight
        s.mu.Lock()
        _, running := s.inFlight[job.ID]
        s.mu.Unlock()
        if running {
            continue
        }

        // Try to acquire pool slot
        select {
        case s.pool <- struct{}{}:
            s.mu.Lock()
            s.skipCount[job.ID] = 0
            s.inFlight[job.ID] = struct{}{}
            s.mu.Unlock()

            s.advanceSchedule(ctx, job)

            runID, err := s.insertRun(ctx, job)
            if err != nil {
                log.Printf("cron: insert run for job %s: %v", job.ID, err)
                <-s.pool
                s.mu.Lock()
                delete(s.inFlight, job.ID)
                s.mu.Unlock()
                continue
            }

            go func(j cronJob, rid int64) {
                defer func() {
                    <-s.pool
                    s.mu.Lock()
                    delete(s.inFlight, j.ID)
                    s.mu.Unlock()
                }()
                s.executeJob(context.Background(), j, rid)
            }(job, runID)

        default:
            // Pool full
            s.mu.Lock()
            s.skipCount[job.ID]++
            count := s.skipCount[job.ID]
            s.mu.Unlock()

            if count >= cronPoolSkipLimit {
                s.recordMissed(ctx, job)
                s.advanceSchedule(ctx, job)
                s.mu.Lock()
                s.skipCount[job.ID] = 0
                s.mu.Unlock()
            }
        }
    }
}

func (s *CronScheduler) executeJob(ctx context.Context, job cronJob, runID int64) {
    var output string
    var exitCode int
    status := "success"

    if job.Command != nil {
        output, exitCode = s.runCommand(ctx, job)
        if exitCode == 124 {
            status = "timeout"
        } else if exitCode != 0 {
            status = "error"
        }
    } else if job.Action != nil {
        output, exitCode = s.runAction(ctx, job)
        if exitCode != 0 {
            status = "error"
        }
    }

    finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    s.db.Exec(finishCtx,
        `UPDATE cron_runs SET status=$1, finished_at=NOW(), exit_code=$2, output=$3 WHERE id=$4`,
        status, exitCode, output, runID)

    // Prune runs > 100 for this job
    var count int
    s.db.QueryRow(finishCtx, `SELECT COUNT(*) FROM cron_runs WHERE job_id=$1`, job.ID).Scan(&count)
    if count > 100 {
        s.db.Exec(finishCtx,
            `DELETE FROM cron_runs WHERE job_id=$1 AND id NOT IN
             (SELECT id FROM cron_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 100)`,
            job.ID)
    }

    // Write audit log entry
    sc := 200
    if status != "success" {
        sc = 500
    }
    s.db.Exec(finishCtx,
        `INSERT INTO audit_log (username, ip, method, path, status_code, duration_ms, body)
         VALUES ('scheduler', '', 'CRON', $1, $2, 0, $3)`,
        fmt.Sprintf("/cron/jobs/%s", job.ID),
        sc,
        fmt.Sprintf(`{"job_id":"%s"}`, job.ID),
    )
}

func (s *CronScheduler) runCommand(ctx context.Context, job cronJob) (string, int) {
    timeout := time.Duration(job.MaxRuntime) * time.Second
    if job.MaxRuntime <= 0 {
        timeout = 24 * time.Hour // effectively unlimited
    }

    execCtx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    cmd := exec.CommandContext(execCtx, "/bin/sh", "-c", *job.Command)
    cmd.Env = []string{
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    }
    for k, v := range job.EnvVars {
        cmd.Env = append(cmd.Env, k+"="+v)
    }

    if job.AppName != "" {
        cmd.Dir = job.appsDir(s.appsDir)
    } else {
        wd, _ := os.Getwd()
        cmd.Dir = wd
    }

    var buf bytes.Buffer
    cmd.Stdout = &buf
    cmd.Stderr = &buf

    err := cmd.Run()
    out := string(truncateOutput(buf.Bytes()))

    if err != nil {
        if execCtx.Err() == context.DeadlineExceeded {
            return out + "\n[timed out]", 124
        }
        if exitErr, ok := err.(*exec.ExitError); ok {
            return out, exitErr.ExitCode()
        }
        return out + "\n" + err.Error(), 1
    }
    return out, 0
}

// appsDir returns the working directory for a command job.
func (j cronJob) appsDir(base string) string {
    if j.AppName == "" {
        return base
    }
    return base + "/" + j.AppName
}

func (s *CronScheduler) runAction(ctx context.Context, job cronJob) (string, int) {
    switch *job.Action {
    case "restart":
        result, err := s.pm2.Action("restart", job.AppName)
        if err != nil {
            return err.Error(), 1
        }
        return result.Stdout, 0

    case "deploy":
        // Build a models.App record and call the extracted DeployApp service function.
        app := &models.App{
            Name:      job.AppName,
            RepoURL:   job.RepoURL,
            Branch:    job.Branch,
            Port:      job.Port,
            MaxMemory: job.MaxMemory,
            EnvVars:   job.EnvVars,
        }
        result, err := DeployApp(app, s.exec, s.appsDir)
        if err != nil {
            return err.Error(), 1
        }
        out := result.Stdout
        if result.Stderr != "" {
            out += "\n" + result.Stderr
        }
        return out, result.Code

    default:
        return fmt.Sprintf("unknown action: %s", *job.Action), 1
    }
}

func (s *CronScheduler) cleanupOrphans(ctx context.Context) {
    // Timed-out runs (timeout_at is set and in the past)
    s.db.Exec(ctx,
        `UPDATE cron_runs SET status='timeout', finished_at=NOW()
         WHERE status='running' AND timeout_at IS NOT NULL AND timeout_at < NOW()`)
    // Other running rows — panel restarted mid-run
    s.db.Exec(ctx,
        `UPDATE cron_runs SET status='error', finished_at=NOW(), output='panel restarted mid-run'
         WHERE status='running'`)
}

func (s *CronScheduler) recordMissed(ctx context.Context, job cronJob) {
    s.db.Exec(ctx,
        `INSERT INTO cron_runs (job_id, started_at, finished_at, status, output)
         VALUES ($1, $2, NOW(), 'missed', 'skipped: panel was offline')`,
        job.ID, job.NextRunAt)
}

func (s *CronScheduler) advanceSchedule(ctx context.Context, job cronJob) {
    sched, err := ParseSchedule(job.Schedule)
    if err != nil {
        return
    }
    next := sched.Next(time.Now())
    s.db.Exec(ctx,
        `UPDATE cron_jobs SET last_run_at=NOW(), next_run_at=$1 WHERE id=$2`,
        next, job.ID)
}

func (s *CronScheduler) insertRun(ctx context.Context, job cronJob) (int64, error) {
    var id int64
    timeoutAt := (*time.Time)(nil)
    if job.MaxRuntime > 0 {
        t := time.Now().Add(time.Duration(job.MaxRuntime) * time.Second)
        timeoutAt = &t
    }
    err := s.db.QueryRow(ctx,
        `INSERT INTO cron_runs (job_id, timeout_at, status) VALUES ($1, $2, 'running') RETURNING id`,
        job.ID, timeoutAt).Scan(&id)
    return id, err
}

func (s *CronScheduler) fetchJob(ctx context.Context, jobID string) (cronJob, error) {
    var j cronJob
    var envJSON []byte
    err := s.db.QueryRow(ctx, `
        SELECT
            j.id, j.app_id,
            COALESCE(a.name,'')        AS app_name,
            COALESCE(a.repo_url,'')    AS repo_url,
            COALESCE(a.branch,'')      AS branch,
            COALESCE(a.port,0)         AS port,
            COALESCE(a.max_memory,512) AS max_memory,
            COALESCE(a.env_vars,'{}')  AS env_vars,
            j.name, j.schedule, j.command, j.action, j.max_runtime, j.next_run_at
        FROM cron_jobs j
        LEFT JOIN apps a ON a.id = j.app_id
        WHERE j.id=$1
    `, jobID).Scan(
        &j.ID, &j.AppID,
        &j.AppName, &j.RepoURL, &j.Branch, &j.Port, &j.MaxMemory, &envJSON,
        &j.Name, &j.Schedule, &j.Command, &j.Action, &j.MaxRuntime, &j.NextRunAt,
    )
    if err != nil {
        return j, err
    }
    j.EnvVars = make(map[string]string)
    if len(envJSON) > 0 {
        json.Unmarshal(envJSON, &j.EnvVars) // best-effort
    }
    return j, nil
}
```

**Imports required at top of cron.go:**
```go
import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "os/exec"
    "sync"
    "time"

    cron "github.com/robfig/cron/v3"

    "panel-backend/internal/models"
)
```

Also replace the two `jsonUnmarshal(envJSON, &j.EnvVars)` calls in `tick()` and `fetchJob()` with `json.Unmarshal(envJSON, &j.EnvVars)`. The `jsonUnmarshal` wrapper helper is not needed — use `json.Unmarshal` directly throughout.

- [ ] **Step 4: Run cron tests**

```bash
cd backend && go test ./internal/services/... -run "TestParseSchedule|TestNextRunAfter|TestTruncateOutput" -v
```
Expected: all `PASS`.

- [ ] **Step 5: Build to catch compile errors**

```bash
cd backend && go build ./...
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/services/cron.go backend/internal/services/cron_test.go
git commit -m "feat(cron): add CronScheduler service"
```

---

## Task 5: Cron HTTP Handlers

**Files:**
- Create: `backend/internal/handlers/cron.go`
- Create: `backend/internal/handlers/cron_test.go`

- [ ] **Step 1: Write failing validation tests**

Create `backend/internal/handlers/cron_test.go`:

```go
package handlers

import (
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

// newTestCronHandler creates a handler with nil db/scheduler (sufficient for validation tests)
func newTestCronHandler() *CronHandler {
    return &CronHandler{db: nil, scheduler: nil}
}

func TestCronCreate_BothCommandAndAction(t *testing.T) {
    h := newTestCronHandler()
    body := `{"name":"test","schedule":"* * * * *","command":"echo hi","action":"restart"}`
    req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    h.Create(w, req)
    if w.Code != http.StatusBadRequest {
        t.Errorf("Expected 400 when both command and action set, got %d: %s", w.Code, w.Body.String())
    }
}

func TestCronCreate_NeitherCommandNorAction(t *testing.T) {
    h := newTestCronHandler()
    body := `{"name":"test","schedule":"* * * * *"}`
    req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    h.Create(w, req)
    if w.Code != http.StatusBadRequest {
        t.Errorf("Expected 400 when neither command nor action set, got %d", w.Code)
    }
}

func TestCronCreate_InvalidAction(t *testing.T) {
    h := newTestCronHandler()
    body := `{"name":"test","schedule":"* * * * *","action":"explode"}`
    req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    h.Create(w, req)
    if w.Code != http.StatusBadRequest {
        t.Errorf("Expected 400 for invalid action, got %d", w.Code)
    }
}

func TestCronCreate_InvalidSchedule(t *testing.T) {
    h := newTestCronHandler()
    body := `{"name":"test","schedule":"not a cron","command":"echo hi"}`
    req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    h.Create(w, req)
    if w.Code != http.StatusBadRequest {
        t.Errorf("Expected 400 for invalid schedule, got %d", w.Code)
    }
}

func TestCronCreate_MissingName(t *testing.T) {
    h := newTestCronHandler()
    body := `{"schedule":"* * * * *","command":"echo hi"}`
    req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    h.Create(w, req)
    if w.Code != http.StatusBadRequest {
        t.Errorf("Expected 400 for missing name, got %d", w.Code)
    }
}

func TestCronCreate_NegativeMaxRuntime(t *testing.T) {
    h := newTestCronHandler()
    body := `{"name":"test","schedule":"* * * * *","command":"echo hi","max_runtime":-1}`
    req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    h.Create(w, req)
    if w.Code != http.StatusBadRequest {
        t.Errorf("Expected 400 for negative max_runtime, got %d", w.Code)
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd backend && go test ./internal/handlers/... -run TestCronCreate -v
```
Expected: `FAIL` — `CronHandler` undefined.

- [ ] **Step 3: Create backend/internal/handlers/cron.go**

```go
package handlers

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"

    "panel-backend/internal/models"
    "panel-backend/internal/services"
)

// CronHandler handles cron job CRUD and run management.
type CronHandler struct {
    db        *services.DB
    scheduler *services.CronScheduler
}

// NewCronHandler creates a CronHandler.
func NewCronHandler(db *services.DB, scheduler *services.CronScheduler) *CronHandler {
    return &CronHandler{db: db, scheduler: scheduler}
}

// cronJobRequest is the create/update payload.
type cronJobRequest struct {
    AppID      *string `json:"app_id"`
    Name       string  `json:"name"`
    Schedule   string  `json:"schedule"`
    Command    *string `json:"command"`
    Action     *string `json:"action"`
    MaxRuntime int     `json:"max_runtime"`
    Enabled    bool    `json:"enabled"`
}

// cronJobResponse is the API representation of a cron job.
type cronJobResponse struct {
    ID         string     `json:"id"`
    AppID      *string    `json:"app_id"`
    Name       string     `json:"name"`
    Schedule   string     `json:"schedule"`
    Command    *string    `json:"command"`
    Action     *string    `json:"action"`
    Enabled    bool       `json:"enabled"`
    MaxRuntime int        `json:"max_runtime"`
    LastRunAt  *time.Time `json:"last_run_at"`
    NextRunAt  time.Time  `json:"next_run_at"`
    CreatedAt  time.Time  `json:"created_at"`
}

// cronRunResponse is the API representation of a cron run.
type cronRunResponse struct {
    ID         int64      `json:"id"`
    JobID      string     `json:"job_id"`
    StartedAt  time.Time  `json:"started_at"`
    FinishedAt *time.Time `json:"finished_at"`
    TimeoutAt  *time.Time `json:"timeout_at"`
    Status     string     `json:"status"`
    ExitCode   *int       `json:"exit_code"`
    Output     string     `json:"output"` // truncated; full via /output endpoint
}

func (h *CronHandler) validateRequest(body cronJobRequest) string {
    if body.Name == "" {
        return "name is required"
    }
    if body.Command == nil && body.Action == nil {
        return "exactly one of command or action must be set"
    }
    if body.Command != nil && body.Action != nil {
        return "exactly one of command or action must be set"
    }
    if body.Action != nil {
        if *body.Action != "restart" && *body.Action != "deploy" {
            return "action must be 'restart' or 'deploy'"
        }
    }
    if body.Schedule == "" {
        return "schedule is required"
    }
    if _, err := services.ParseSchedule(body.Schedule); err != nil {
        return fmt.Sprintf("invalid schedule: %v", err)
    }
    if body.MaxRuntime < 0 {
        return "max_runtime must be >= 0"
    }
    return ""
}

// List handles GET /api/cron/jobs
func (h *CronHandler) List(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    appID := r.URL.Query().Get("app_id")

    query := `SELECT id, app_id, name, schedule, command, action, enabled, max_runtime,
                     last_run_at, next_run_at, created_at
              FROM cron_jobs ORDER BY created_at DESC`
    args := []interface{}{}
    if appID != "" {
        query = `SELECT id, app_id, name, schedule, command, action, enabled, max_runtime,
                        last_run_at, next_run_at, created_at
                 FROM cron_jobs WHERE app_id=$1 ORDER BY created_at DESC`
        args = append(args, appID)
    }

    rows, err := h.db.Query(ctx, query, args...)
    if err != nil {
        Error(w, http.StatusInternalServerError, "Failed to fetch cron jobs")
        return
    }
    defer rows.Close()

    jobs := make([]cronJobResponse, 0)
    for rows.Next() {
        var j cronJobResponse
        if err := rows.Scan(&j.ID, &j.AppID, &j.Name, &j.Schedule, &j.Command, &j.Action,
            &j.Enabled, &j.MaxRuntime, &j.LastRunAt, &j.NextRunAt, &j.CreatedAt); err != nil {
            Error(w, http.StatusInternalServerError, "Failed to scan cron job")
            return
        }
        jobs = append(jobs, j)
    }
    Success(w, jobs)
}

// Create handles POST /api/cron/jobs
func (h *CronHandler) Create(w http.ResponseWriter, r *http.Request) {
    var body cronJobRequest
    body.MaxRuntime = 300 // default
    body.Enabled = true
    if err := ReadJSON(r, &body); err != nil {
        Error(w, http.StatusBadRequest, "Invalid request body")
        return
    }

    if msg := h.validateRequest(body); msg != "" {
        Error(w, http.StatusBadRequest, msg)
        return
    }

    if h.db == nil {
        Error(w, http.StatusInternalServerError, "no database")
        return
    }

    sched, _ := services.ParseSchedule(body.Schedule)
    nextRun := sched.Next(time.Now())

    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    var id string
    err := h.db.QueryRow(ctx,
        `INSERT INTO cron_jobs (app_id, name, schedule, command, action, enabled, max_runtime, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        body.AppID, body.Name, body.Schedule, body.Command, body.Action,
        body.Enabled, body.MaxRuntime, nextRun,
    ).Scan(&id)
    if err != nil {
        Error(w, http.StatusInternalServerError, "Failed to create cron job")
        return
    }

    Success(w, map[string]string{"id": id})
}

// Get handles GET /api/cron/jobs/:id
func (h *CronHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    var j cronJobResponse
    err := h.db.QueryRow(ctx,
        `SELECT id, app_id, name, schedule, command, action, enabled, max_runtime,
                last_run_at, next_run_at, created_at
         FROM cron_jobs WHERE id=$1`, id,
    ).Scan(&j.ID, &j.AppID, &j.Name, &j.Schedule, &j.Command, &j.Action,
        &j.Enabled, &j.MaxRuntime, &j.LastRunAt, &j.NextRunAt, &j.CreatedAt)
    if err != nil {
        Error(w, http.StatusNotFound, "Cron job not found")
        return
    }
    Success(w, j)
}

// Update handles PUT /api/cron/jobs/:id
func (h *CronHandler) Update(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")

    var body cronJobRequest
    if err := ReadJSON(r, &body); err != nil {
        Error(w, http.StatusBadRequest, "Invalid request body")
        return
    }
    if msg := h.validateRequest(body); msg != "" {
        Error(w, http.StatusBadRequest, msg)
        return
    }

    sched, _ := services.ParseSchedule(body.Schedule)
    nextRun := sched.Next(time.Now())

    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    tag, err := h.db.Exec(ctx,
        `UPDATE cron_jobs SET name=$1, schedule=$2, command=$3, action=$4,
                              enabled=$5, max_runtime=$6, next_run_at=$7
         WHERE id=$8`,
        body.Name, body.Schedule, body.Command, body.Action,
        body.Enabled, body.MaxRuntime, nextRun, id)
    if err != nil || tag.RowsAffected() == 0 {
        Error(w, http.StatusNotFound, "Cron job not found")
        return
    }
    Success(w, map[string]string{"message": "updated"})
}

// Delete handles DELETE /api/cron/jobs/:id
func (h *CronHandler) Delete(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    tag, err := h.db.Exec(ctx, `DELETE FROM cron_jobs WHERE id=$1`, id)
    if err != nil || tag.RowsAffected() == 0 {
        Error(w, http.StatusNotFound, "Cron job not found")
        return
    }
    Success(w, map[string]string{"message": "deleted"})
}

// Toggle handles POST /api/cron/jobs/:id/toggle
func (h *CronHandler) Toggle(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    var enabled bool
    err := h.db.QueryRow(ctx, `UPDATE cron_jobs SET enabled = NOT enabled WHERE id=$1 RETURNING enabled`, id).Scan(&enabled)
    if err != nil {
        Error(w, http.StatusNotFound, "Cron job not found")
        return
    }
    Success(w, map[string]bool{"enabled": enabled})
}

// RunNow handles POST /api/cron/jobs/:id/run
func (h *CronHandler) RunNow(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")

    if h.scheduler.IsRunning(id) {
        Error(w, http.StatusConflict, "job is already running")
        return
    }

    if err := h.scheduler.RunNow(r.Context(), id); err != nil {
        if err.Error() == "job is already running" {
            Error(w, http.StatusConflict, err.Error())
            return
        }
        Error(w, http.StatusNotFound, "Cron job not found")
        return
    }
    Success(w, map[string]string{"message": "job dispatched"})
}

// Runs handles GET /api/cron/jobs/:id/runs
func (h *CronHandler) Runs(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    rows, err := h.db.Query(ctx,
        `SELECT id, job_id, started_at, finished_at, timeout_at, status, exit_code,
                LEFT(output, 200) AS output_preview
         FROM cron_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 100`, id)
    if err != nil {
        Error(w, http.StatusInternalServerError, "Failed to fetch runs")
        return
    }
    defer rows.Close()

    runs := make([]cronRunResponse, 0)
    for rows.Next() {
        var run cronRunResponse
        if err := rows.Scan(&run.ID, &run.JobID, &run.StartedAt, &run.FinishedAt, &run.TimeoutAt,
            &run.Status, &run.ExitCode, &run.Output); err != nil {
            Error(w, http.StatusInternalServerError, "Failed to scan run")
            return
        }
        runs = append(runs, run)
    }
    Success(w, runs)
}

// RunOutput handles GET /api/cron/jobs/:id/runs/:run_id/output
func (h *CronHandler) RunOutput(w http.ResponseWriter, r *http.Request) {
    runID := chi.URLParam(r, "run_id")
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    var output string
    err := h.db.QueryRow(ctx, `SELECT output FROM cron_runs WHERE id=$1`, runID).Scan(&output)
    if err != nil {
        Error(w, http.StatusNotFound, "Run not found")
        return
    }
    Success(w, map[string]string{"output": output})
}
```

- [ ] **Step 4: Run validation tests**

```bash
cd backend && go test ./internal/handlers/... -run TestCronCreate -v
```
Expected: all `PASS`.

- [ ] **Step 5: Build**

```bash
cd backend && go build ./...
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handlers/cron.go backend/internal/handlers/cron_test.go
git commit -m "feat(cron): add CronHandler with 9 REST routes"
```

---

## Task 6: Wire Scheduler and Routes in main.go

**Files:**
- Modify: `backend/main.go`

- [ ] **Step 1: Add CronScheduler and CronHandler to main.go**

In `backend/main.go`, after the line creating `backupHandler`:

```go
// --- ADD THESE LINES ---
// Cron scheduler (starts background goroutine)
cronScheduler := services.NewCronScheduler(db, pm2, exec, cfg.AppsDir)
cronHandler := handlers.NewCronHandler(db, cronScheduler)

// Start the scheduler using a context that cancels on shutdown
schedulerCtx, schedulerCancel := context.WithCancel(ctx)
_ = schedulerCancel // cancelled explicitly below
cronScheduler.Start(schedulerCtx)
```

- [ ] **Step 2: Stop the scheduler on shutdown**

In the graceful shutdown section (after `<-done`), before `srv.Shutdown(...)`:

```go
// Stop cron scheduler and mark in-flight runs as errored
schedulerCancel()
cronScheduler.Stop()
```

- [ ] **Step 3: Add cron routes**

Inside the compressed JSON group (after the backups routes block), add:

```go
// Cron jobs
r.Get("/cron/jobs", cronHandler.List)
r.Post("/cron/jobs", cronHandler.Create)
r.Get("/cron/jobs/{id}", cronHandler.Get)
r.Put("/cron/jobs/{id}", cronHandler.Update)
r.Delete("/cron/jobs/{id}", cronHandler.Delete)
r.Post("/cron/jobs/{id}/toggle", cronHandler.Toggle)
r.Post("/cron/jobs/{id}/run", cronHandler.RunNow)
r.Get("/cron/jobs/{id}/runs", cronHandler.Runs)
r.Get("/cron/jobs/{id}/runs/{run_id}/output", cronHandler.RunOutput)
```

- [ ] **Step 4: Build**

```bash
cd backend && go build ./...
```
Expected: no output.

- [ ] **Step 5: Run all tests**

```bash
cd backend && go test ./...
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/main.go
git commit -m "feat(cron): wire CronScheduler and CronHandler into main"
```

---

## Task 7: Frontend — Types and StatusBadge

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/components/StatusBadge.tsx`

- [ ] **Step 1: Add CronJob and CronRun types to api.ts**

Append to the end of `frontend/src/lib/api.ts`:

```typescript
export interface CronJob {
  id: string;
  app_id: string | null;
  name: string;
  schedule: string;
  command: string | null;
  action: string | null;
  enabled: boolean;
  max_runtime: number;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
}

export interface CronRun {
  id: number;
  job_id: string;
  started_at: string;
  finished_at: string | null;
  timeout_at: string | null;
  status: 'running' | 'success' | 'error' | 'timeout' | 'missed';
  exit_code: number | null;
  output: string;
}
```

- [ ] **Step 2: Extend StatusBadge with cron statuses**

In `frontend/src/components/StatusBadge.tsx`, add to the `cfg` record:

```typescript
success: { cls: 'badge-green',  dot: 'bg-emerald-400', label: 'Success' },
error:   { cls: 'badge-red',    dot: 'bg-red-400',     label: 'Error'   },
timeout: { cls: 'badge-yellow', dot: 'bg-amber-400',   label: 'Timeout' },
missed:  { cls: 'badge-gray',   dot: 'bg-gray-500',    label: 'Missed'  },
```

Also update the `animate-pulse` condition to include `success`:
```typescript
status === 'online' || status === 'running'
```
(no change needed — `success` should not animate, existing logic is fine)

- [ ] **Step 3: Build frontend**

```bash
cd frontend && npm run build 2>&1 | tail -5
```
Expected: `✓ built in Xs` with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/StatusBadge.tsx
git commit -m "feat(cron): add CronJob/CronRun types and extend StatusBadge"
```

---

## Task 8: Server-Wide Cron Page

**Files:**
- Create: `frontend/src/pages/Cron.tsx`

This page lists jobs where `app_id = null`. Same layout as the app cron tab (Task 9), but scoped to server-wide jobs.

- [ ] **Step 1: Create frontend/src/pages/Cron.tsx**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Clock, Plus, Play, ToggleLeft, ToggleRight, Trash2, Edit2, ChevronDown, ChevronRight } from 'lucide-react';
import Shell from '@/components/Shell';
import StatusBadge from '@/components/StatusBadge';
import Modal from '@/components/Modal';
import { api, CronJob, CronRun } from '@/lib/api';
import CronJobModal from '@/components/CronJobModal';

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function duration(run: CronRun): string {
  if (!run.finished_at) return '…';
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function Cron() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, CronRun[]>>({});
  const [outputModal, setOutputModal] = useState<{ jobId: string; runId: number } | null>(null);
  const [outputText, setOutputText] = useState('');
  const [showJobModal, setShowJobModal] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    const res = await api.get<CronJob[]>('/cron/jobs');
    if (res.success && res.data) {
      setJobs(res.data.filter(j => j.app_id === null));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // Poll runs for expanded job every 5s
  const fetchRuns = useCallback(async (jobId: string) => {
    const res = await api.get<CronRun[]>(`/cron/jobs/${jobId}/runs`);
    if (res.success && res.data) {
      setRuns(prev => ({ ...prev, [jobId]: res.data! }));
    }
  }, []);

  useEffect(() => {
    if (!expandedJob) return;
    fetchRuns(expandedJob);
    const iv = setInterval(() => fetchRuns(expandedJob), 5000);
    return () => clearInterval(iv);
  }, [expandedJob, fetchRuns]);

  async function toggleJob(id: string) {
    setActing(id + ':toggle');
    await api.post(`/cron/jobs/${id}/toggle`);
    await fetchJobs();
    setActing(null);
  }

  async function runNow(id: string) {
    setActing(id + ':run');
    await api.post(`/cron/jobs/${id}/run`);
    setActing(null);
  }

  async function deleteJob(id: string) {
    if (!confirm('Delete this cron job?')) return;
    await api.delete(`/cron/jobs/${id}`);
    await fetchJobs();
  }

  async function showOutput(jobId: string, runId: number) {
    setOutputModal({ jobId, runId });
    const res = await api.get<{ output: string }>(`/cron/jobs/${jobId}/runs/${runId}/output`);
    setOutputText(res.data?.output ?? '');
  }

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <span className="h-6 w-6 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/20 border border-violet-500/20">
              <Clock size={18} className="text-violet-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Cron Jobs</h1>
              <p className="text-xs text-gray-500 mt-0.5">Server-wide scheduled tasks</p>
            </div>
          </div>
          <button
            onClick={() => { setEditingJob(null); setShowJobModal(true); }}
            className="flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            <Plus size={14} /> Add Job
          </button>
        </div>

        {/* Jobs list */}
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Clock size={36} className="text-gray-700 mb-3" />
            <p className="text-gray-400 font-medium">No cron jobs yet</p>
            <p className="text-xs text-gray-600 mt-1">Add a server-wide scheduled task</p>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map(job => (
              <div key={job.id} className="rounded-xl border border-white/[0.06] overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.02)' }}>
                {/* Job row */}
                <div
                  className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                  onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                >
                  <button className="text-gray-600 hover:text-gray-400 transition-colors shrink-0">
                    {expandedJob === job.id
                      ? <ChevronDown size={14} />
                      : <ChevronRight size={14} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200 truncate">{job.name}</p>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">{job.schedule}</p>
                  </div>
                  <div className="hidden sm:block text-xs text-gray-500 shrink-0">
                    Last: {relativeTime(job.last_run_at)}
                  </div>
                  <div className="hidden sm:block text-xs text-gray-500 shrink-0">
                    Next: {relativeTime(job.next_run_at)}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); toggleJob(job.id); }}
                    className="text-gray-500 hover:text-violet-400 transition-colors shrink-0"
                    title={job.enabled ? 'Disable' : 'Enable'}
                  >
                    {job.enabled ? <ToggleRight size={18} className="text-emerald-400" /> : <ToggleLeft size={18} />}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); runNow(job.id); }}
                    disabled={acting === job.id + ':run'}
                    className="text-gray-500 hover:text-blue-400 transition-colors shrink-0"
                    title="Run now"
                  >
                    <Play size={14} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setEditingJob(job); setShowJobModal(true); }}
                    className="text-gray-500 hover:text-gray-300 transition-colors shrink-0"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); deleteJob(job.id); }}
                    className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Run history */}
                {expandedJob === job.id && (
                  <div className="border-t border-white/[0.05] px-4 py-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Run History</p>
                    {!runs[job.id] || runs[job.id].length === 0 ? (
                      <p className="text-xs text-gray-600">No runs yet</p>
                    ) : (
                      <div className="space-y-1">
                        {runs[job.id].map(run => (
                          <div key={run.id}
                            className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white/[0.02] cursor-pointer transition-colors"
                            onClick={() => showOutput(job.id, run.id)}
                          >
                            <StatusBadge status={run.status} />
                            <span className="text-xs text-gray-400">{relativeTime(run.started_at)}</span>
                            <span className="text-xs text-gray-600">{duration(run)}</span>
                            <span className="text-xs text-gray-600 font-mono truncate flex-1">{run.output}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Output modal */}
      {outputModal && (
        <Modal onClose={() => setOutputModal(null)}>
          <div className="p-4">
            <p className="text-sm font-semibold text-white mb-3">Run Output</p>
            <pre className="text-xs text-gray-300 font-mono bg-black/40 rounded-lg p-4 overflow-auto max-h-96 whitespace-pre-wrap">
              {outputText || '(empty)'}
            </pre>
          </div>
        </Modal>
      )}

      {/* Add/Edit job modal */}
      {showJobModal && (
        <CronJobModal
          job={editingJob}
          appId={null}
          onClose={() => setShowJobModal(false)}
          onSaved={() => { setShowJobModal(false); fetchJobs(); }}
        />
      )}
    </Shell>
  );
}
```

- [ ] **Step 2: Create the shared CronJobModal component**

Create `frontend/src/components/CronJobModal.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { api, CronJob } from '@/lib/api';

const PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Hourly',          value: '0 * * * *'   },
  { label: 'Daily midnight',  value: '0 0 * * *'   },
  { label: 'Weekly (Sun)',    value: '0 0 * * 0'   },
  { label: 'Monthly',        value: '0 0 1 * *'   },
  { label: 'Custom…',        value: '__custom__'  },
];

interface Props {
  job: CronJob | null;
  appId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CronJobModal({ job, appId, onClose, onSaved }: Props) {
  const [name, setName] = useState(job?.name ?? '');
  const [preset, setPreset] = useState('0 0 * * *');
  const [customSchedule, setCustomSchedule] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [type, setType] = useState<'command' | 'action'>(job?.command ? 'command' : 'action');
  const [command, setCommand] = useState(job?.command ?? '');
  const [action, setAction] = useState(job?.action ?? 'restart');
  const [maxRuntime, setMaxRuntime] = useState(job?.max_runtime ?? 300);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (job) {
      const matched = PRESETS.find(p => p.value === job.schedule && p.value !== '__custom__');
      if (matched) {
        setPreset(job.schedule);
        setIsCustom(false);
      } else {
        setPreset('__custom__');
        setCustomSchedule(job.schedule);
        setIsCustom(true);
      }
    }
  }, [job]);

  function getSchedule(): string {
    return isCustom ? customSchedule : preset;
  }

  async function save() {
    setSaving(true);
    setError('');

    const payload = {
      app_id: appId,
      name,
      schedule: getSchedule(),
      command: type === 'command' ? command : null,
      action: type === 'action' ? action : null,
      max_runtime: maxRuntime,
      enabled,
    };

    const res = job
      ? await api.put(`/cron/jobs/${job.id}`, payload)
      : await api.post('/cron/jobs', payload);

    if (res.success) {
      onSaved();
    } else {
      setError(res.error ?? 'Failed to save');
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl overflow-hidden animate-slide-up"
        style={{ background: '#0d0d1a', border: '1px solid rgba(255,255,255,0.1)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
          <h2 className="text-sm font-semibold text-white">{job ? 'Edit Cron Job' : 'New Cron Job'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Nightly cleanup"
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-violet-500/50" />
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Schedule</label>
            <select
              value={isCustom ? '__custom__' : preset}
              onChange={e => {
                if (e.target.value === '__custom__') {
                  setIsCustom(true);
                  setPreset('__custom__');
                } else {
                  setIsCustom(false);
                  setPreset(e.target.value);
                }
              }}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-violet-500/50"
            >
              {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            {isCustom && (
              <input value={customSchedule} onChange={e => setCustomSchedule(e.target.value)}
                placeholder="*/5 * * * *"
                className="mt-2 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:border-violet-500/50" />
            )}
          </div>

          {/* Type toggle */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Type</label>
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              {(['command', 'action'] as const).map(t => (
                <button key={t}
                  onClick={() => setType(t)}
                  className={`flex-1 py-2 text-xs font-medium transition-colors capitalize
                    ${type === t ? 'bg-violet-600 text-white' : 'bg-white/5 text-gray-400 hover:text-gray-200'}`}>
                  {t === 'command' ? 'Shell Command' : 'App Action'}
                </button>
              ))}
            </div>
          </div>

          {/* Command / Action */}
          {type === 'command' ? (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Command</label>
              <textarea value={command} onChange={e => setCommand(e.target.value)}
                rows={3}
                placeholder="node scripts/cleanup.js"
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:border-violet-500/50 resize-none" />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Action</label>
              <select value={action} onChange={e => setAction(e.target.value)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-violet-500/50">
                <option value="restart">Restart app</option>
                <option value="deploy">Deploy (git pull + rebuild)</option>
              </select>
            </div>
          )}

          {/* Max runtime */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">
              Max runtime (seconds) — 0 = unlimited
            </label>
            <input type="number" min={0} value={maxRuntime}
              onChange={e => setMaxRuntime(Number(e.target.value))}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-violet-500/50" />
          </div>

          {/* Enabled */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
              className="w-4 h-4 rounded accent-violet-500" />
            <span className="text-sm text-gray-300">Enabled</span>
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-white/[0.07]">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-xl transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : (job ? 'Save Changes' : 'Create Job')}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```
Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Cron.tsx frontend/src/components/CronJobModal.tsx
git commit -m "feat(cron): add server-wide Cron page and CronJobModal component"
```

---

## Task 9: AppDetail Cron Tab

**Files:**
- Modify: `frontend/src/pages/AppDetail.tsx`

- [ ] **Step 1: Extend Tab type**

In `AppDetail.tsx`, find:
```typescript
type Tab = 'overview' | 'logs' | 'configuration' | 'deployments';
```
Change to:
```typescript
type Tab = 'overview' | 'logs' | 'configuration' | 'deployments' | 'cron';
```

- [ ] **Step 2: Add cron-related imports**

Add to the existing imports at the top:
```typescript
import { CronJob, CronRun } from '@/lib/api';
import CronJobModal from '@/components/CronJobModal';
import StatusBadge from '@/components/StatusBadge';
```
(Some may already be imported — only add the missing ones.)

Also add lucide icons used in the cron tab:
```typescript
Clock, ToggleLeft, ToggleRight, Play, Edit2
```
(Add to the existing lucide import line.)

- [ ] **Step 3: Add cron state variables**

Inside the `AppDetail` component, add alongside the existing state:
```typescript
const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
const [cronRuns, setCronRuns] = useState<Record<string, CronRun[]>>({});
const [expandedCronJob, setExpandedCronJob] = useState<string | null>(null);
const [showCronModal, setShowCronModal] = useState(false);
const [editingCronJob, setEditingCronJob] = useState<CronJob | null>(null);
const [cronOutputModal, setCronOutputModal] = useState<{ jobId: string; runId: number } | null>(null);
const [cronOutputText, setCronOutputText] = useState('');
```

- [ ] **Step 4: Add fetchCronJobs + fetchCronRuns effects**

Add these callbacks and effects alongside the existing `fetchApp` effect:

```typescript
const fetchCronJobs = useCallback(async () => {
  if (!app) return;
  const res = await api.get<CronJob[]>(`/cron/jobs?app_id=${app.id}`);
  if (res.success && res.data) setCronJobs(res.data);
}, [app]);

const fetchCronRuns = useCallback(async (jobId: string) => {
  const res = await api.get<CronRun[]>(`/cron/jobs/${jobId}/runs`);
  if (res.success && res.data) setCronRuns(prev => ({ ...prev, [jobId]: res.data! }));
}, []);

useEffect(() => {
  if (tab === 'cron' && app) fetchCronJobs();
}, [tab, app, fetchCronJobs]);

useEffect(() => {
  if (!expandedCronJob) return;
  fetchCronRuns(expandedCronJob);
  const iv = setInterval(() => fetchCronRuns(expandedCronJob), 5000);
  return () => clearInterval(iv);
}, [expandedCronJob, fetchCronRuns]);
```

- [ ] **Step 5: Add cron tab button to the tab bar**

Find the tab buttons section (where `overview`, `logs`, `configuration`, `deployments` tabs are rendered). Add a `cron` tab button in the same style as the others:

```tsx
<button
  onClick={() => setTab('cron')}
  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
    ${tab === 'cron'
      ? 'border-violet-500 text-violet-400'
      : 'border-transparent text-gray-400 hover:text-gray-200'}`}
>
  <Clock size={13} /> Cron
</button>
```

- [ ] **Step 6: Add cron tab panel**

Find where the tab content is rendered (the `{tab === 'deployments' && ...}` block). Add after it:

```tsx
{tab === 'cron' && (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-gray-300">Cron Jobs</h3>
      <button
        onClick={() => { setEditingCronJob(null); setShowCronModal(true); }}
        className="flex items-center gap-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-xs font-medium text-white transition-colors"
      >
        <Plus size={12} /> Add Job
      </button>
    </div>

    {cronJobs.length === 0 ? (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Clock size={32} className="text-gray-700 mb-3" />
        <p className="text-sm text-gray-500">No cron jobs for this app</p>
      </div>
    ) : (
      <div className="space-y-2">
        {cronJobs.map(job => (
          <div key={job.id} className="rounded-xl border border-white/[0.06] overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.02)' }}>
            <div
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
              onClick={() => setExpandedCronJob(expandedCronJob === job.id ? null : job.id)}
            >
              <span className="text-gray-600">
                {expandedCronJob === job.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-200 truncate">{job.name}</p>
                <p className="text-xs font-mono text-gray-500 mt-0.5">{job.schedule}</p>
              </div>
              <span className="text-xs text-gray-500 hidden sm:block">
                Last: {job.last_run_at ? new Date(job.last_run_at).toLocaleString() : 'Never'}
              </span>
              <button onClick={async e => { e.stopPropagation(); await api.post(`/cron/jobs/${job.id}/toggle`); fetchCronJobs(); }}
                className="text-gray-500 hover:text-violet-400 transition-colors shrink-0">
                {job.enabled ? <ToggleRight size={17} className="text-emerald-400" /> : <ToggleLeft size={17} />}
              </button>
              <button onClick={e => { e.stopPropagation(); api.post(`/cron/jobs/${job.id}/run`); }}
                className="text-gray-500 hover:text-blue-400 transition-colors shrink-0" title="Run now">
                <Play size={13} />
              </button>
              <button onClick={e => { e.stopPropagation(); setEditingCronJob(job); setShowCronModal(true); }}
                className="text-gray-500 hover:text-gray-300 transition-colors shrink-0">
                <Edit2 size={13} />
              </button>
              <button onClick={e => {
                e.stopPropagation();
                if (confirm('Delete this cron job?')) api.delete(`/cron/jobs/${job.id}`).then(fetchCronJobs);
              }} className="text-gray-500 hover:text-red-400 transition-colors shrink-0">
                <Trash2 size={13} />
              </button>
            </div>

            {expandedCronJob === job.id && (
              <div className="border-t border-white/[0.05] px-4 py-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Run History</p>
                {!cronRuns[job.id] || cronRuns[job.id].length === 0 ? (
                  <p className="text-xs text-gray-600 py-2">No runs yet</p>
                ) : (
                  <div className="space-y-1">
                    {cronRuns[job.id].map(run => {
                      const dur = run.finished_at
                        ? ((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000).toFixed(1) + 's'
                        : '…';
                      return (
                        <div key={run.id}
                          className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white/[0.02] cursor-pointer transition-colors"
                          onClick={async () => {
                            setCronOutputModal({ jobId: job.id, runId: run.id });
                            const r = await api.get<{ output: string }>(`/cron/jobs/${job.id}/runs/${run.id}/output`);
                            setCronOutputText(r.data?.output ?? '');
                          }}
                        >
                          <StatusBadge status={run.status} />
                          <span className="text-xs text-gray-500">{new Date(run.started_at).toLocaleString()}</span>
                          <span className="text-xs text-gray-600">{dur}</span>
                          <span className="text-xs text-gray-600 font-mono truncate flex-1">{run.output}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 7: Add cron modals at the bottom of the component return**

Just before the closing `</Shell>` tag, add:

```tsx
{showCronModal && app && (
  <CronJobModal
    job={editingCronJob}
    appId={app.id}
    onClose={() => setShowCronModal(false)}
    onSaved={() => { setShowCronModal(false); fetchCronJobs(); }}
  />
)}

{cronOutputModal && (
  <Modal onClose={() => setCronOutputModal(null)}>
    <div className="p-4">
      <p className="text-sm font-semibold text-white mb-3">Run Output</p>
      <pre className="text-xs text-gray-300 font-mono bg-black/40 rounded-lg p-4 overflow-auto max-h-96 whitespace-pre-wrap">
        {cronOutputText || '(empty)'}
      </pre>
    </div>
  </Modal>
)}
```

- [ ] **Step 8: Build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```
Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/AppDetail.tsx
git commit -m "feat(cron): add cron tab to AppDetail page"
```

---

## Task 10: Nav Link and Route

**Files:**
- Modify: `frontend/src/components/Nav.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add Cron to NAV_LINKS in Nav.tsx**

In `frontend/src/components/Nav.tsx`, import the `Clock` icon:
```typescript
import { ..., Clock } from 'lucide-react';
```

Add to `NAV_LINKS` (after `AuditLog` and before `Settings`):
```typescript
{ href: '/cron', label: 'Cron Jobs', icon: Clock, color: 'text-violet-400' },
```

- [ ] **Step 2: Add /cron route in App.tsx**

In `frontend/src/App.tsx`:

```typescript
import Cron from '@/pages/Cron';
```

Add inside the `<Routes>` block:
```tsx
<Route path="/cron" element={<ProtectedRoute><Cron /></ProtectedRoute>} />
```

- [ ] **Step 3: Final build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```
Expected: no TypeScript errors, no warnings.

- [ ] **Step 4: Run all backend tests one final time**

```bash
cd backend && go test ./...
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Nav.tsx frontend/src/App.tsx
git commit -m "feat(cron): add Cron Jobs nav link and /cron route"
```

---

## Done

All tasks complete. The feature is live at:
- **App cron tab:** `/apps/<name>` → Cron tab
- **Server-wide cron:** `/cron`
- **Backend API:** `GET/POST/PUT/DELETE /api/cron/jobs`, `/api/cron/jobs/:id/runs`
