# Hardening Batch A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the audit's "this week" fixes (path guard, cron deploy script, health checks, NGINX correctness, `.env` permissions, fail2ban, executor timeouts, three frontend bugs), repo hygiene, CI, and finally purge the leaked `scripts/deploy.py` from history.

**Architecture:** Thirteen independent tasks on one branch, each a self-contained fix with a unit test; a GitHub Actions workflow so the whole Go suite runs on Linux; the history purge runs last, after merge, because it rewrites SHAs.

**Tech Stack:** Go 1.22 (chi, pgx), Bash, React 18 + TypeScript + Vite + Tailwind 3, GitHub Actions, git-filter-repo.

**Spec:** `docs/superpowers/specs/2026-09-11-hardening-batch-a-design.md`

## Global Constraints

- Every fix has a unit test that fails before and passes after; tests must run on Windows (`filepath`, `t.TempDir()`, `t.Skip` when `os.Symlink` fails) and on Linux CI.
- Pre-existing Windows-only failures (`TestSanitizeFilename`, `TestPathTraversalGuard`, `TestValidateDomain`) are FIXED by this batch (Tasks 2 and 6); after Task 6, `go test ./...` must be fully green on Windows too.
- Public function signatures stay unchanged except `services.NewExecutor(scriptsDir, appsDir string, deployTimeout time.Duration)` (Task 7) and `handlers.HealthResult` gaining `Static bool` (Task 4).
- NGINX SSL cipher list, verbatim: `ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305`; HSTS header verbatim: `add_header Strict-Transport-Security "max-age=63072000" always;`.
- Lockout log line, verbatim: `Login lockout: IP %s locked for 15 minutes after 5 failed attempts`.
- `DEPLOY_TIMEOUT` env: Go duration string, default `15m`, minimum `1m`.
- Domains are lowercased and trimmed before validation and storage; migration 6 lowercases existing rows.
- Working tree is CRLF on the dev machine: judge `gofmt` on committed blobs (`git show HEAD:path > "$TEMP/x.go" && gofmt -l "$TEMP/x.go"`).
- Never write the leaked password literal into any file, report, or commit; the purge task reads it from the deleted file at run time.
- Do not commit `frontend/tsconfig.tsbuildinfo` (it is untracked from Task 1 on) or `backend/.env`.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never use `git stash` (shared stash stack); work only inside the worktree created in Task 0.

---

## File Map

| File | Change |
|---|---|
| `.gitignore` | add `cookies.txt`, `*.exe`, `*.exe~`, `frontend/tsconfig.tsbuildinfo`, `.superpowers/`; remove `backend/go.sum` line |
| `frontend/package.json`, `frontend/package-lock.json` | `react-router-dom` `^6.30.6` |
| `scripts/deploy.py` | deleted (tracked) |
| `backend/internal/handlers/files.go` | `resolveAppPath`; four guards replaced |
| `backend/internal/handlers/files_test.go` | `TestPathTraversalGuard` rewritten; OS-aware `TestSanitizeFilename` |
| `backend/internal/services/deploy.go` | `AppScriptEnv`; `DeployApp` → `deploy_app.sh` |
| `backend/internal/services/deploy_test.go` | `TestAppScriptEnv` |
| `backend/internal/services/cron.go` | select app-type fields; pass them to `DeployApp` |
| `backend/internal/handlers/apps.go` | `appEnvFromApp` delegates to `services.AppScriptEnv` |
| `backend/internal/services/executor.go` | allowlist without `deploy_next_app.sh`; `deployTimeout`; single `run`; `WaitDelay` |
| `backend/internal/services/executor_unix.go`, `executor_windows.go` | `setProcessGroup` |
| `backend/internal/services/executor_test.go`, `executor_unix_test.go` | allowlist update; `TestValidateDomain` fix; process-group test |
| `scripts/deploy_next_app.sh` | deleted |
| `backend/internal/handlers/health.go` | `classifyApp`; `Static` field |
| `backend/internal/handlers/health_test.go` | `TestClassifyApp` |
| `backend/internal/services/nginx.go` | four templates corrected |
| `backend/internal/services/nginx_test.go` | `TestBuildConfigTemplates` |
| `nginx-templates/app.conf.example` | regenerated to match; `panel.conf.example` deleted |
| `backend/internal/handlers/domains.go`, `ssl.go` | `normalizeDomain` |
| `backend/internal/handlers/domains_test.go` | `TestNormalizeDomain` |
| `backend/internal/services/db.go` | migration 6 |
| `backend/internal/config/config.go` | `DeployTimeout` |
| `backend/main.go` | pass `cfg.DeployTimeout` |
| `backend/internal/handlers/auth.go`, `auth_test.go` | lockout log line + test |
| `scripts/setup_panel.sh` | umask/chmod, fail2ban backend, fatal hash failure, stdin password |
| `scripts/deploy_app.sh`, `scripts/setup_app.sh` | OUTPUT_DIR checks, cleanup rule, subshell, root-dir error |
| `frontend/src/pages/Apps.tsx`, `Settings.tsx`, `AppDetail.tsx`, + 8 pages | copy, refs, `/8`→`/10`, chip map, poll-error |
| `.github/workflows/ci.yml`, `README.md` | CI + badge |

---

## Task 0: Branch and worktree (controller)

- [ ] **Step 1:** From `C:/Users/User/Documents/panel` on `main` (HEAD `5b64a71` or later): `git worktree add .worktrees/hardening-batch-a -b feat/hardening-batch-a`, then in the worktree `cd backend && go mod download && go build ./...` and `cd frontend && npm ci`.
- [ ] **Step 2:** Baseline: `go test ./...` shows exactly the three known Windows failures; `npx tsc -b` silent.

---

## Task 1: Repo hygiene and dependency patch

**Files:**
- Modify: `.gitignore`
- Delete: `scripts/deploy.py`
- Modify: `frontend/package.json`, `frontend/package-lock.json`
- Untrack: `frontend/tsconfig.tsbuildinfo`

- [ ] **Step 1: Edit `.gitignore`**

Remove the line `backend/go.sum` (and the comment `# Go sum (resolved on build)` above it). Under `# Environment files — NEVER commit these` add `cookies.txt`. Under `# Build output — Go` add:

```
backend/panel-server.exe
backend/panel-server.exe~
*.exe
*.exe~
```

Under `# Build output — Vite` add `frontend/tsconfig.tsbuildinfo`. Under `# Claude` add `.superpowers/`.

- [ ] **Step 2: Untrack the build artifact and delete the leaked script from the tree**

```bash
git rm --cached frontend/tsconfig.tsbuildinfo
git rm scripts/deploy.py
```

- [ ] **Step 3: Patch react-router**

```bash
cd frontend && npm install react-router-dom@^6.30.6 && npm audit --omit=dev 2>&1 | tail -3 && npx tsc -b && cd ..
```
Expected: audit reports `found 0 vulnerabilities`; tsc silent.

- [ ] **Step 4: Verify ignore rules**

```bash
git check-ignore -v cookies.txt backend/panel-server.exe frontend/tsconfig.tsbuildinfo .superpowers/x
git check-ignore backend/go.sum && echo "BAD: go.sum still ignored" || echo "go.sum not ignored (correct)"
git status --short
```
Expected: four ignore matches; go.sum not ignored; status shows only `.gitignore`, `frontend/package*.json`, the two deletions.

- [ ] **Step 5: Commit**

```bash
git add .gitignore frontend/package.json frontend/package-lock.json
git commit -m "chore: ignore build artifacts and cookies, untrack tsbuildinfo, drop leaked deploy script, patch react-router

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(`git rm` already staged the deletion and the untrack.)

---

## Task 2: File-manager path guard

**Files:**
- Modify: `backend/internal/handlers/files.go`
- Modify: `backend/internal/handlers/files_test.go`

**Interfaces:**
- Produces: `func resolveAppPath(appDir, sub string) (string, error)`; `var errPathEscape = errors.New("path escapes app directory")`.

- [ ] **Step 1: Rewrite the two tests**

Replace `TestPathTraversalGuard` in `files_test.go` with:

```go
func TestPathTraversalGuard(t *testing.T) {
	root := t.TempDir()
	appDir := filepath.Join(root, "myapp")
	if err := os.MkdirAll(filepath.Join(appDir, "src", "components"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "myapp2"), 0755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		subPath string
		safe    bool
	}{
		{"valid root", "", true},
		{"valid subdir", "src", true},
		{"valid nested", "src/components/App.tsx", true},
		{"valid missing file", "src/new.txt", true},
		{"double dot in name", "..hidden", true},
		{"encoded traversal is a plain name", "..%2F..%2Fetc%2Fpasswd", true},
		{"traversal up", "../", false},
		{"traversal to other app", "../otherapp/secrets", false},
		{"traversal to etc", "../../../etc/passwd", false},
		{"absolute path", "/etc/passwd", false},
		{"sibling prefix", "../myapp2/.env", false},
		{"sibling prefix nested", "src/../../myapp2/.env", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAppPath(appDir, tt.subPath)
			if (err == nil) != tt.safe {
				t.Fatalf("resolveAppPath(%q) = %q, %v; want safe=%v", tt.subPath, got, err, tt.safe)
			}
			if err == nil && got != filepath.Clean(filepath.Join(appDir, tt.subPath)) {
				t.Errorf("resolved %q, want %q", got, filepath.Clean(filepath.Join(appDir, tt.subPath)))
			}
		})
	}

	t.Run("symlink inside app pointing outside is rejected", func(t *testing.T) {
		outside := filepath.Join(root, "outside")
		if err := os.MkdirAll(outside, 0755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(appDir, "link")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("symlinks not permitted: %v", err)
		}
		if _, err := resolveAppPath(appDir, "link/secret"); err == nil {
			t.Error("expected symlink escape to be rejected")
		}
		if _, err := resolveAppPath(appDir, "link"); err == nil {
			t.Error("expected symlink itself to be rejected")
		}
	})
}
```

And in `TestSanitizeFilename` replace the case `{"strip windows path", "C:\\Users\\file.txt", "file.txt"},` with:

```go
		{"strip windows path", "C:\\Users\\file.txt", windowsPathExpectation()},
```
and add, above the test function:

```go
// windowsPathExpectation: filepath.Base only splits on backslash on Windows.
// On Linux the whole string is one segment containing ':' and '\', which the
// filename regex rejects.
func windowsPathExpectation() string {
	if runtime.GOOS == "windows" {
		return "file.txt"
	}
	return ""
}
```
Add `"os"` and `"runtime"` to the test file's imports.

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run 'TestPathTraversalGuard|TestSanitizeFilename' -v 2>&1 | tail -5
```
Expected: compile error `undefined: resolveAppPath`.

- [ ] **Step 3: Add the helper to `files.go`**

Add `"errors"` to the imports, then after the `var ( blockedExtensions … filenameRegex … )` block:

```go
var errPathEscape = errors.New("path escapes app directory")

// resolveAppPath returns the cleaned absolute path of sub inside appDir, or
// errPathEscape if sub would leave appDir via "..", an absolute path, or a
// symlink. The deepest existing ancestor of the target is resolved with
// EvalSymlinks so a symlink planted inside the app directory cannot point
// outside it. appDir itself may not exist yet (uploads create it).
func resolveAppPath(appDir, sub string) (string, error) {
	base, err := filepath.Abs(appDir)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(sub) || strings.HasPrefix(sub, "/") || strings.HasPrefix(sub, `\`) {
		return "", errPathEscape
	}
	target := filepath.Clean(filepath.Join(base, sub))
	if !insideDir(base, target) {
		return "", errPathEscape
	}

	// Walk up to the deepest existing ancestor of target.
	existing := target
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		existing = parent
	}
	// Only check symlinks for the part at or below base; ancestors above
	// base are outside our control and irrelevant.
	if !insideDir(base, existing) {
		return target, nil
	}
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		resolvedBase = base // base does not exist yet
	}
	resolvedExisting, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	if !insideDir(resolvedBase, resolvedExisting) {
		return "", errPathEscape
	}
	return target, nil
}

// insideDir reports whether p equals dir or lies beneath it (both cleaned).
func insideDir(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
```

- [ ] **Step 4: Replace the four inline guards**

In `List`, `GetContent`, `SaveContent`, `Upload`, replace each block of the form

```go
	appDir := filepath.Join(h.cfg.AppsDir, appName)
	targetDir := filepath.Join(appDir, subPath)   // or filePath := …

	// Path traversal guard
	resolved, err := filepath.Abs(targetDir)
	if err != nil || !strings.HasPrefix(resolved, filepath.Clean(appDir)) {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}
```
with
```go
	appDir := filepath.Join(h.cfg.AppsDir, appName)
	resolved, err := resolveAppPath(appDir, subPath)
	if err != nil {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}
```
(keep the variable name `resolved`; everything after each guard already uses it). In `Upload`, additionally replace `destPath := filepath.Join(resolved, name)` with:

```go
		destPath, err := resolveAppPath(appDir, filepath.Join(subPath, name))
		if err != nil {
			continue
		}
```

- [ ] **Step 5: Run the tests, build, vet**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run 'TestPathTraversalGuard|TestSanitizeFilename|TestBlockedExtensions' -count=1 -v 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Expected: all `--- PASS` (the symlink subtest may be `--- SKIP` on Windows), `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handlers/files.go backend/internal/handlers/files_test.go
git commit -m "fix(files): resolve app paths with Rel and EvalSymlinks; close sibling-prefix and symlink escapes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Cron deploy uses `deploy_app.sh`; retire `deploy_next_app.sh`

**Files:**
- Modify: `backend/internal/services/deploy.go`, `deploy_test.go`, `cron.go`, `executor.go`, `executor_test.go`
- Modify: `backend/internal/handlers/apps.go` (`appEnvFromApp`)
- Delete: `scripts/deploy_next_app.sh`

**Interfaces:**
- Produces: `func AppScriptEnv(app *models.App) map[string]string` in `services`.

- [ ] **Step 1: Write failing tests**

Append to `backend/internal/services/deploy_test.go`:

```go
func TestAppScriptEnv(t *testing.T) {
	app := &models.App{
		AppType: "vite", RootDir: "/web", OutputDir: "build",
		BuildCmd: "npm run build", StartCmd: "node s.js", InstallCmd: "pnpm i",
	}
	got := AppScriptEnv(app)
	want := map[string]string{
		"APP_TYPE": "vite", "ROOT_DIR": "/web", "OUTPUT_DIR": "build",
		"BUILD_CMD": "npm run build", "START_CMD": "node s.js", "INSTALL_CMD": "pnpm i",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d keys, want %d: %v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}
```
(ensure `"panel-backend/internal/models"` is imported in that test file.)

In `executor_test.go` `TestAllowedScripts`, change the `expected` list to `install_nginx.sh, install_postgres.sh, install_redis.sh, deploy_app.sh, setup_app.sh, create_ssl.sh` and add `"deploy_next_app.sh"` to the `dangerous` list (keep `"../deploy_next_app.sh"` too).

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/services/ -run 'TestAppScriptEnv|TestAllowedScripts' -v 2>&1 | grep -E '^(--- |ok|FAIL|.*undefined)'
```
Expected: `undefined: AppScriptEnv`; after a stub, `TestAllowedScripts` fails on `deploy_next_app.sh`.

- [ ] **Step 3: Implement**

`deploy.go`: replace `DeployApp` with:

```go
// AppScriptEnv returns the environment the deploy/setup scripts read for an app.
func AppScriptEnv(app *models.App) map[string]string {
	return map[string]string{
		"APP_TYPE":    app.AppType,
		"ROOT_DIR":    app.RootDir,
		"OUTPUT_DIR":  app.OutputDir,
		"BUILD_CMD":   app.BuildCmd,
		"START_CMD":   app.StartCmd,
		"INSTALL_CMD": app.InstallCmd,
	}
}

// DeployApp writes the .env file and runs deploy_app.sh for the given app.
// Used by the cron scheduler; HTTP handlers call WriteEnvFile directly.
func DeployApp(app *models.App, exec *Executor, appsDir string) (*models.ExecResult, error) {
	if err := WriteEnvFile(appsDir, app.Name, app.EnvVars); err != nil {
		log.Printf("[warn] DeployApp: failed to write .env for %s: %v", app.Name, err)
	}
	return exec.RunScriptEnv("deploy_app.sh", AppScriptEnv(app),
		app.Name, app.RepoURL, app.Branch,
		fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
}
```

`handlers/apps.go`: replace the body of `appEnvFromApp` with `return services.AppScriptEnv(app)`.

`executor.go`: delete the `"deploy_next_app.sh": true,` line from `allowedScripts`, and in both `RunScript` and `RunScriptEnv` change the timeout condition to `if script == "deploy_app.sh" || script == "setup_app.sh"`.

`cron.go`: add fields to `cronJob`: `AppType, RootDir, OutputDir, BuildCmd, StartCmd, InstallCmd string`. In BOTH queries (`tick` and `fetchJob`) add after the `env_vars` column:

```sql
            COALESCE(a.app_type,'next')    AS app_type,
            COALESCE(a.root_dir,'/')       AS root_dir,
            COALESCE(a.output_dir,'dist')  AS output_dir,
            COALESCE(a.build_cmd,'')       AS build_cmd,
            COALESCE(a.start_cmd,'')       AS start_cmd,
            COALESCE(a.install_cmd,'')     AS install_cmd,
```
and extend both `Scan` calls with `&j.AppType, &j.RootDir, &j.OutputDir, &j.BuildCmd, &j.StartCmd, &j.InstallCmd,` right after `&envJSON,`. In `runAction` `case "deploy"`, extend the `models.App` literal with `AppType: job.AppType, RootDir: job.RootDir, OutputDir: job.OutputDir, BuildCmd: job.BuildCmd, StartCmd: job.StartCmd, InstallCmd: job.InstallCmd,`.

Delete the script: `git rm scripts/deploy_next_app.sh`. Grep to confirm nothing else references it: `grep -rn deploy_next_app --include=*.go --include=*.sh --include=*.md . | grep -v docs/superpowers` — the README project-structure block still lists it; remove that line from `README.md` too.

- [ ] **Step 4: Verify**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/services/ -run 'TestAppScriptEnv|TestAllowedScripts|TestWriteEnvFile' -count=1 -v 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/services/deploy.go backend/internal/services/deploy_test.go backend/internal/services/cron.go backend/internal/services/executor.go backend/internal/services/executor_test.go backend/internal/handlers/apps.go README.md
git commit -m "fix(cron): deploy action uses deploy_app.sh with app type fields; retire deploy_next_app.sh

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(`git rm` staged the script deletion.)

---

## Task 4: Health checker treats static apps as healthy

**Files:**
- Modify: `backend/internal/handlers/health.go`
- Create: `backend/internal/handlers/health_test.go`

**Interfaces:**
- Produces: `func classifyApp(appType, startCmd, pm2Status string) (probe bool, skipped *HealthResult)`; `HealthResult.Static bool \`json:"static"\``.

- [ ] **Step 1: Failing test**

```go
package handlers

import "testing"

func TestClassifyApp(t *testing.T) {
	tests := []struct {
		name      string
		appType   string
		startCmd  string
		pm2Status string
		wantProbe bool
		wantOK    bool
		wantStat  bool
	}{
		{"next online is probed", "next", "", "online", true, false, false},
		{"node stopped is unhealthy, not probed", "node", "", "stopped", false, false, false},
		{"node unknown to pm2", "node", "", "", false, false, false},
		{"vite is static healthy", "vite", "", "", false, true, true},
		{"static is static healthy", "static", "", "", false, true, true},
		{"custom without start cmd is static", "custom", "", "", false, true, true},
		{"custom with start cmd online is probed", "custom", "node s.js", "online", true, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probe, res := classifyApp(tt.appType, tt.startCmd, tt.pm2Status)
			if probe != tt.wantProbe {
				t.Fatalf("probe = %v, want %v", probe, tt.wantProbe)
			}
			if probe {
				if res != nil {
					t.Errorf("expected nil result when probing")
				}
				return
			}
			if res == nil {
				t.Fatal("expected a result when not probing")
			}
			if res.Healthy != tt.wantOK || res.Static != tt.wantStat {
				t.Errorf("Healthy=%v Static=%v, want %v %v", res.Healthy, res.Static, tt.wantOK, tt.wantStat)
			}
			if !tt.wantOK && res.Error == "" {
				t.Errorf("unhealthy result must carry an error message")
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify failure** — `cd backend && go test ./internal/handlers/ -run TestClassifyApp -v` → `undefined: classifyApp`.

- [ ] **Step 3: Implement**

In `health.go`, add `Static bool \`json:"static"\`` to `HealthResult` (after `FailCount`). Add:

```go
// classifyApp decides whether an app needs an HTTP probe. When it does not,
// the returned result is recorded as-is (static apps are healthy by
// definition; process apps that PM2 does not report online are unhealthy).
func classifyApp(appType, startCmd, pm2Status string) (bool, *HealthResult) {
	if services.IsStaticType(appType, startCmd) {
		return false, &HealthResult{Healthy: true, Static: true}
	}
	if pm2Status != "online" {
		return false, &HealthResult{Healthy: false, Error: "not running (PM2 status: " + pm2Status + ")"}
	}
	return true, nil
}
```

Change `checkAll`: the query becomes `"SELECT name, port, app_type, start_cmd FROM apps"`; `appInfo` gains `appType, startCmd string`; scan `&a.name, &a.port, &a.appType, &a.startCmd`. Replace the loop body

```go
		status := pm2Status[app.name]
		if status != "online" {
			…
			continue
		}
		h.checkApp(app.name, app.port)
```
with
```go
		probe, res := classifyApp(app.appType, app.startCmd, pm2Status[app.name])
		if !probe {
			res.AppName = app.name
			res.LastCheck = time.Now()
			h.mu.Lock()
			h.results[app.name] = res
			h.mu.Unlock()
			continue
		}
		h.checkApp(app.name, app.port)
```

- [ ] **Step 4: Verify** — `cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run TestClassifyApp -count=1 -v | grep -E '^(--- |ok|FAIL)'` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/health.go backend/internal/handlers/health_test.go
git commit -m "fix(health): treat static apps as healthy instead of 'not running'

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: NGINX templates

**Files:**
- Modify: `backend/internal/services/nginx.go` (`BuildConfig`, `BuildStaticConfig`)
- Create: `backend/internal/services/nginx_test.go`
- Modify: `nginx-templates/app.conf.example`; Delete: `nginx-templates/panel.conf.example`

- [ ] **Step 1: Failing test**

```go
package services

import (
	"strings"
	"testing"
)

const modernCiphers = "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"

func TestBuildConfigTemplates(t *testing.T) {
	n := NewNginx(nil, "/tmp/avail", "/tmp/enabled")
	cases := []struct {
		name string
		cfg  string
		ssl  bool
		want []string
		deny []string
	}{
		{"proxy http", n.BuildConfig("app.example.com", 3001, false), false,
			[]string{"listen 80;", "listen [::]:80;", "proxy_set_header X-Forwarded-Proto $scheme;", "proxy_pass http://app_app_example_com;"},
			[]string{"listen 443", "X-Forwarded-Proto https"}},
		{"proxy https", n.BuildConfig("app.example.com", 3001, true), true,
			[]string{"listen [::]:80;", "listen 443 ssl http2;", "listen [::]:443 ssl http2;", "proxy_set_header X-Forwarded-Proto https;"},
			[]string{"X-Forwarded-Proto $scheme"}},
		{"static http", n.BuildStaticConfig("site.example.com", "/var/www/apps/site/dist", false), false,
			[]string{"listen 80;", "listen [::]:80;", "root /var/www/apps/site/dist;"},
			[]string{"listen 443"}},
		{"static https", n.BuildStaticConfig("site.example.com", "/var/www/apps/site/dist", true), true,
			[]string{"listen [::]:443 ssl http2;", "root /var/www/apps/site/dist;"},
			nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for _, w := range c.want {
				if !strings.Contains(c.cfg, w) {
					t.Errorf("missing %q", w)
				}
			}
			for _, d := range c.deny {
				if strings.Contains(c.cfg, d) {
					t.Errorf("unexpected %q", d)
				}
			}
			if strings.Contains(c.cfg, "HIGH:!aNULL:!MD5") {
				t.Errorf("weak cipher list present")
			}
			if c.ssl {
				for _, w := range []string{
					"ssl_ciphers " + modernCiphers + ";",
					"ssl_prefer_server_ciphers off;",
					"ssl_session_cache shared:PanelSSL:10m;",
					`add_header Strict-Transport-Security "max-age=63072000" always;`,
					"add_header X-Content-Type-Options nosniff always;",
				} {
					if !strings.Contains(c.cfg, w) {
						t.Errorf("ssl template missing %q", w)
					}
				}
			}
			if strings.HasPrefix(c.name, "static") && c.ssl {
				// security headers must be repeated inside location blocks that add their own headers
				if strings.Count(c.cfg, `add_header Strict-Transport-Security "max-age=63072000" always;`) < 3 {
					t.Errorf("HSTS must be repeated in each add_header location block")
				}
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify failure** — `cd backend && go test ./internal/services/ -run TestBuildConfigTemplates -v` → FAIL on `listen [::]:80;` etc.

- [ ] **Step 3: Rewrite the four templates in `nginx.go`**

Add near the top of the file:

```go
// sslSettings is shared by both SSL templates (Mozilla "intermediate" profile).
const sslSettings = `    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:PanelSSL:10m;

    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Content-Type-Options nosniff always;
`

// securityHeaders is repeated inside location blocks that set their own
// add_header, because NGINX does not inherit add_header into such blocks.
const securityHeaders = `        add_header Strict-Transport-Security "max-age=63072000" always;
        add_header X-Content-Type-Options nosniff always;
`
```

`BuildConfig` SSL branch becomes:

```go
		return fmt.Sprintf(`# Managed by Panel -- do not edit manually
upstream %s {
    include %s;
}

server {
    listen 80;
    listen [::]:80;
    server_name %s;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name %s;

    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;

%s
    client_max_body_size 100M;

    location / {
        proxy_pass http://%s;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
`, upstream, include, domain, domain, domain, domain, sslSettings, upstream)
```

`BuildConfig` non-SSL branch: add `    listen [::]:80;` after `    listen 80;` and change `X-Forwarded-Proto https;` to `X-Forwarded-Proto $scheme;`.

`BuildStaticConfig` SSL branch becomes:

```go
		return fmt.Sprintf(`# Managed by Panel -- do not edit manually
server {
    listen 80;
    listen [::]:80;
    server_name %s;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name %s;

    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;

%s
    client_max_body_size 100M;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    root %s;
    index index.html;

    location = /index.html {
        add_header Cache-Control "no-cache";
%s    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
%s    }
}
`, domain, domain, domain, domain, sslSettings, docRoot, securityHeaders, securityHeaders)
```

`BuildStaticConfig` non-SSL branch: add `    listen [::]:80;` after `    listen 80;` (no other change).

- [ ] **Step 4: Update the example template**

Overwrite `nginx-templates/app.conf.example` with the output of the SSL proxy template for `app.example.com`/port 3001 (copy the generated text; keep the two-line header comment `# /etc/nginx/sites-available/app.example.com` and `# Auto-generated by Panel — regenerate from the Domains page.`). `git rm nginx-templates/panel.conf.example`. In `README.md` project structure, remove the `panel.conf.example` line.

- [ ] **Step 5: Verify** — `cd backend && go build ./... && go vet ./... && go test ./internal/services/ -run TestBuildConfigTemplates -count=1 -v | grep -E '^(--- |ok|FAIL)'` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/services/nginx.go backend/internal/services/nginx_test.go nginx-templates/app.conf.example README.md
git commit -m "fix(nginx): IPv6 listeners, \$scheme on HTTP proxies, modern TLS settings and security headers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Domain normalisation + migration 6 + test correction

**Files:**
- Modify: `backend/internal/handlers/domains.go`, `ssl.go`
- Create: `backend/internal/handlers/domains_test.go`
- Modify: `backend/internal/services/executor_test.go`, `db.go`

**Interfaces:**
- Produces: `func normalizeDomain(s string) string` in `handlers`.

- [ ] **Step 1: Failing tests**

`domains_test.go`:
```go
package handlers

import "testing"

func TestNormalizeDomain(t *testing.T) {
	tests := map[string]string{
		"Example.COM":      "example.com",
		"  app.example.com ": "app.example.com",
		"already.lower":    "already.lower",
		"":                 "",
	}
	for in, want := range tests {
		if got := normalizeDomain(in); got != want {
			t.Errorf("normalizeDomain(%q) = %q, want %q", in, got, want)
		}
	}
}
```
In `executor_test.go` `TestValidateDomain`, change `{"invalid uppercase rejected", "Example.COM", false},` to `{"mixed case accepted (normalised by handlers)", "Example.COM", true},`.

- [ ] **Step 2: Run to verify failure** — `go test ./internal/handlers/ -run TestNormalizeDomain` → undefined; `go test ./internal/services/ -run TestValidateDomain` → now PASS (the code already accepted it; the test was wrong).

- [ ] **Step 3: Implement**

`domains.go`: add
```go
// normalizeDomain lowercases and trims a domain before validation/storage so
// NGINX file names, certbot paths and DB lookups agree.
func normalizeDomain(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
```
In `Add`: after `ReadJSON`, `body.Domain = normalizeDomain(body.Domain)`. In `Remove`: `domain := normalizeDomain(chi.URLParam(r, "domain"))`. In `ssl.go` `Enable` and `Disable`: `body.Domain = normalizeDomain(body.Domain)` right after `ReadJSON` succeeds.

`db.go`: append migration:
```go
	{
		version:     6,
		description: "Lowercase existing domain names",
		sql:         `UPDATE domains SET domain = lower(domain) WHERE domain <> lower(domain);`,
	},
```

- [ ] **Step 4: Verify** — `cd backend && go build ./... && go vet ./... && go test ./... -count=1 2>&1 | grep -E '^(ok|FAIL|--- FAIL)'`. Expected: every package `ok` — this is the point where the Windows suite becomes fully green.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/domains.go backend/internal/handlers/ssl.go backend/internal/handlers/domains_test.go backend/internal/services/executor_test.go backend/internal/services/db.go
git commit -m "fix(domains): normalise to lowercase before validation and storage; migration 6

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: Executor process groups, single runner, configurable deploy timeout

**Files:**
- Modify: `backend/internal/config/config.go`, `backend/main.go`, `backend/internal/services/executor.go`
- Create: `backend/internal/services/executor_unix.go`, `executor_windows.go`, `executor_unix_test.go`
- Modify: `backend/internal/services/executor_test.go` (if it constructs `NewExecutor`)

**Interfaces:**
- `config.Config.DeployTimeout time.Duration`
- `NewExecutor(scriptsDir, appsDir string, deployTimeout time.Duration) *Executor`
- private `func (e *Executor) run(binary string, args []string, timeout time.Duration, o runOpts) (*models.ExecResult, error)` with `type runOpts struct { extraEnv map[string]string; stdin io.Reader; stdout io.Writer }`
- `func setProcessGroup(cmd *exec.Cmd)` (unix: Setpgid + group kill; windows: no-op)

- [ ] **Step 1: Failing tests**

`executor_unix_test.go`:
```go
//go:build !windows

package services

import (
	"testing"
	"time"
)

// A timed-out script must not leave its children holding the stdout pipe:
// with process-group kill, run returns within a couple of seconds; without it
// cmd.Wait blocks until WaitDelay (10s) or the child exits (30s).
func TestRunKillsProcessGroup(t *testing.T) {
	e := NewExecutor(t.TempDir(), t.TempDir(), time.Minute)
	start := time.Now()
	res, err := e.run("/bin/bash", []string{"-c", "sleep 30 & wait"}, time.Second, runOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Code != timeoutCode {
		t.Errorf("code = %d, want %d", res.Code, timeoutCode)
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Errorf("run took %v; children were not killed with the process group", el)
	}
}
```
Append to `config_test.go` (create `backend/internal/config/config_test.go` if missing):
```go
package config

import (
	"testing"
	"time"
)

func TestParseDeployTimeout(t *testing.T) {
	tests := map[string]time.Duration{
		"":    15 * time.Minute,
		"20m": 20 * time.Minute,
		"30s": 1 * time.Minute, // below minimum → clamped
		"bad": 15 * time.Minute,
	}
	for in, want := range tests {
		if got := parseDeployTimeout(in); got != want {
			t.Errorf("parseDeployTimeout(%q) = %v, want %v", in, got, want)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure** — `go test ./internal/config/ -run TestParseDeployTimeout` → undefined; `go vet ./...` fails on the `run` reference in the unix test (Linux only; on Windows the file is excluded — that is expected).

- [ ] **Step 3: Config**

`config.go`: add `DeployTimeout time.Duration` to `Config`; in `Load` add `DeployTimeout: parseDeployTimeout(getEnv("DEPLOY_TIMEOUT", "")),`; add (import `time`):
```go
// parseDeployTimeout reads DEPLOY_TIMEOUT as a Go duration; default 15m, minimum 1m.
func parseDeployTimeout(s string) time.Duration {
	const def, min = 15 * time.Minute, 1 * time.Minute
	if s == "" {
		return def
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		log.Printf("WARNING: invalid DEPLOY_TIMEOUT %q, using %s", s, def)
		return def
	}
	if d < min {
		return min
	}
	return d
}
```
`main.go`: `exec := services.NewExecutor(cfg.ScriptsDir, cfg.AppsDir, cfg.DeployTimeout)`.

- [ ] **Step 4: Executor**

Replace the whole body of `executor.go` from `// Executor runs shell commands safely` down to (but not including) `// limitedWriter limits …` with:

```go
// Executor runs shell commands safely
type Executor struct {
	scriptsDir    string
	appsDir       string
	deployTimeout time.Duration
}

// NewExecutor creates a new executor. deployTimeout bounds deploy/setup scripts;
// everything else uses defaultTimeout.
func NewExecutor(scriptsDir, appsDir string, deployTimeout time.Duration) *Executor {
	if deployTimeout <= 0 {
		deployTimeout = deployTimeout0
	}
	return &Executor{scriptsDir: scriptsDir, appsDir: appsDir, deployTimeout: deployTimeout}
}

// deployTimeout0 is the fallback when no timeout is configured.
const deployTimeout0 = 15 * time.Minute

// runOpts carries the optional parts of a run.
type runOpts struct {
	extraEnv map[string]string // extra KEY=VALUE pairs (keys must be shell-safe)
	stdin    io.Reader         // piped to the child's stdin when non-nil
	stdout   io.Writer         // streams stdout here instead of buffering when non-nil
}

func (e *Executor) scriptTimeout(script string) time.Duration {
	if script == "deploy_app.sh" || script == "setup_app.sh" {
		return e.deployTimeout
	}
	return defaultTimeout
}

// RunScript runs an allowed shell script with arguments
func (e *Executor) RunScript(script string, args ...string) (*models.ExecResult, error) {
	return e.RunScriptEnv(script, nil, args...)
}

// RunScriptEnv runs an allowed shell script with extra environment variables and arguments.
func (e *Executor) RunScriptEnv(script string, extraEnv map[string]string, args ...string) (*models.ExecResult, error) {
	if !allowedScripts[script] {
		return nil, fmt.Errorf("script not allowed: %s", script)
	}
	allArgs := append([]string{e.scriptsDir + "/" + script}, args...)
	return e.run("/bin/bash", allArgs, e.scriptTimeout(script), runOpts{extraEnv: extraEnv})
}

// RunBin runs an allowed binary with arguments
func (e *Executor) RunBin(bin string, args ...string) (*models.ExecResult, error) {
	binPath, ok := allowedBins[bin]
	if !ok {
		return nil, fmt.Errorf("binary not allowed: %s", bin)
	}
	return e.run(binPath, args, defaultTimeout, runOpts{})
}

// RunBinStream runs an allowed binary and streams stdout directly to w.
// Used for large outputs like pg_dump where buffering is not practical.
func (e *Executor) RunBinStream(w io.Writer, bin string, args ...string) error {
	binPath, ok := allowedBins[bin]
	if !ok {
		return fmt.Errorf("binary not allowed: %s", bin)
	}
	res, err := e.run(binPath, args, 5*time.Minute, runOpts{stdout: w})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return fmt.Errorf("exit status %d: %s", res.Code, res.Stderr)
	}
	return nil
}

// RunBinWithStdin runs an allowed binary and pipes r into its stdin.
// Used for operations like pg_restore / psql restore.
func (e *Executor) RunBinWithStdin(r io.Reader, bin string, args ...string) (*models.ExecResult, error) {
	binPath, ok := allowedBins[bin]
	if !ok {
		return nil, fmt.Errorf("binary not allowed: %s", bin)
	}
	return e.run(binPath, args, 10*time.Minute, runOpts{stdin: r})
}

// run executes a command with a restricted environment, a timeout that kills
// the whole process group, and bounded output buffers.
func (e *Executor) run(binary string, args []string, timeout time.Duration, o runOpts) (*models.ExecResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, args...)
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"APPS_DIR=" + e.appsDir,
	}
	for k, v := range o.extraEnv {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	cmd.WaitDelay = 10 * time.Second
	setProcessGroup(cmd)

	if o.stdin != nil {
		cmd.Stdin = o.stdin
	}
	var stdout, stderr bytes.Buffer
	if o.stdout != nil {
		cmd.Stdout = o.stdout
	} else {
		cmd.Stdout = &limitedWriter{buf: &stdout, max: maxOutputSize}
	}
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxOutputSize}

	err := cmd.Run()
	result := &models.ExecResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result.Code = timeoutCode
			result.Stderr += "\n... command timed out"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.Code = exitErr.ExitCode()
		} else {
			result.Code = 1
			result.Stderr = err.Error()
		}
	}
	return result, nil
}
```
Delete the old `deployTimeout` constant from the `const (...)` block at the top (keep `maxOutputSize`, `defaultTimeout`, `timeoutCode`). Remove the now-unused `spawnSafe`.

`executor_unix.go`:
```go
//go:build !windows

package services

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the child in its own process group and makes context
// cancellation kill the whole group, so npm/next/git grandchildren of a
// timed-out bash script do not survive as orphans holding the output pipes.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
```
`executor_windows.go`:
```go
//go:build windows

package services

import "os/exec"

// setProcessGroup is a no-op on Windows (dev machine only; the panel runs on Linux).
func setProcessGroup(cmd *exec.Cmd) {}
```
If any existing test calls `NewExecutor(a, b)`, update it to `NewExecutor(a, b, time.Minute)`.

- [ ] **Step 5: Verify**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/config/ ./internal/services/ -count=1 2>&1 | grep -E '^(ok|FAIL|--- FAIL)'
```
Expected: `ok` for both. Then cross-compile for Linux to catch the unix file: `GOOS=linux GOARCH=amd64 go vet ./...` (silent). The process-group test itself runs on CI (Task 12).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/config backend/main.go backend/internal/services/executor.go backend/internal/services/executor_unix.go backend/internal/services/executor_windows.go backend/internal/services/executor_unix_test.go backend/internal/services/executor_test.go
git commit -m "fix(executor): kill the whole process group on timeout, single runner, DEPLOY_TIMEOUT setting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Login lockout log line

**Files:**
- Modify: `backend/internal/handlers/auth.go`, `auth_test.go`

- [ ] **Step 1: Failing test** (append to `auth_test.go`; add `"bytes"`, `"log"` to imports)

```go
func TestLockoutLogsLine(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	h := newTestAuthHandler()
	for i := 0; i < 4; i++ {
		h.recordFailure("203.0.113.7")
	}
	if strings.Contains(buf.String(), "Login lockout") {
		t.Fatalf("lockout logged before the 5th failure: %s", buf.String())
	}
	h.recordFailure("203.0.113.7")
	want := "Login lockout: IP 203.0.113.7 locked for 15 minutes after 5 failed attempts"
	if !strings.Contains(buf.String(), want) {
		t.Fatalf("expected log line %q, got %q", want, buf.String())
	}
	if strings.Count(buf.String(), "Login lockout") != 1 {
		t.Errorf("lockout must be logged exactly once")
	}
}
```
(add `"os"` to imports too.)

- [ ] **Step 2: Run to verify failure** — `go test ./internal/handlers/ -run TestLockoutLogsLine -v` → FAIL "expected log line".

- [ ] **Step 3: Implement** — in `recordFailure`, replace
```go
	attempt.count++
	if attempt.count >= maxLoginAttempts {
		attempt.lockedUntil = time.Now().Add(lockoutDuration)
	}
```
with
```go
	attempt.count++
	if attempt.count == maxLoginAttempts {
		attempt.lockedUntil = time.Now().Add(lockoutDuration)
		// Exact format is matched by the fail2ban filter in scripts/setup_panel.sh.
		log.Printf("Login lockout: IP %s locked for 15 minutes after 5 failed attempts", ip)
	} else if attempt.count > maxLoginAttempts {
		attempt.lockedUntil = time.Now().Add(lockoutDuration)
	}
```

- [ ] **Step 4: Verify** — `cd backend && go test ./internal/handlers/ -run 'TestLockoutLogsLine|TestLogin' -count=1 -v | grep -E '^(--- |ok|FAIL)'` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/auth.go backend/internal/handlers/auth_test.go
git commit -m "fix(auth): log a fail2ban-matchable line when an IP is locked out

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: `setup_panel.sh` hardening

**Files:**
- Modify: `scripts/setup_panel.sh`

- [ ] **Step 1: `.env` permissions** — change `cat > "${PANEL_DIR}/backend/.env" <<EOF` to `( umask 077; cat > "${PANEL_DIR}/backend/.env" <<EOF` and add a line `)` after the `EOF` terminator, so the heredoc runs inside the subshell. After `ok "Config written to backend/.env"` add `chmod 600 "${PANEL_DIR}/backend/.env"`. After the line `echo "ADMIN_PASSWORD_HASH='${BCRYPT_HASH}'" >> "${PANEL_DIR}/backend/.env"` add `chmod 600 "${PANEL_DIR}/backend/.env"`.

- [ ] **Step 2: Hash via stdin and fatal on failure** — in the embedded Go program replace `os.Args[1]` handling with reading stdin:
```go
	data, err := io.ReadAll(os.Stdin)
	if err != nil || len(data) == 0 {
		os.Exit(1)
	}
	hash, err := bcrypt.GenerateFromPassword(bytes.TrimRight(data, "\r\n"), 12)
```
(imports `bytes`, `io`; drop the `len(os.Args)` check). Change the call to `BCRYPT_HASH=$(cd /tmp/panel-hash && printf '%s' "${ADMIN_PASS}" | go run main.go 2>/dev/null || echo "")`. Replace the whole `else` fallback branch with:
```bash
else
  fail "Could not generate the admin password hash (Go toolchain problem?). Aborting — refusing to write a plaintext password."
fi
```
(`fail` already exists in the script and exits non-zero; verify with `grep -n '^fail()' scripts/setup_panel.sh`.)

- [ ] **Step 3: fail2ban backend** — in the `jail.local` heredoc change `backend  = systemd` to `backend  = auto`.

- [ ] **Step 4: Verify**

```bash
bash -n scripts/setup_panel.sh && grep -n 'umask 077\|chmod 600 "${PANEL_DIR}/backend/.env"\|backend  = auto\|refusing to write a plaintext' scripts/setup_panel.sh
shellcheck -S warning scripts/setup_panel.sh 2>&1 | tail -3 || echo "shellcheck not installed locally — CI runs it"
```
Expected: `bash -n` silent; four grep hits (chmod appears twice).

- [ ] **Step 5: Commit**

```bash
git add scripts/setup_panel.sh
git commit -m "fix(setup): write backend/.env with mode 600, fail hard when hashing fails, fail2ban backend=auto

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 10: Deploy/setup script fixes

**Files:**
- Modify: `scripts/deploy_app.sh`, `scripts/setup_app.sh`

- [ ] **Step 1: OUTPUT_DIR validation (both scripts)** — replace
```bash
if [[ "$OUTPUT_DIR" =~ \.\. ]]; then
  echo "[error] OUTPUT_DIR must not contain .." >&2; exit 1
fi
```
with
```bash
if [[ "$OUTPUT_DIR" =~ \.\. ]]; then
  echo "[error] OUTPUT_DIR must not contain .." >&2; exit 1
fi
if [[ "$OUTPUT_DIR" == "." || "$OUTPUT_DIR" == "./" || "$OUTPUT_DIR" == "/" || -z "$OUTPUT_DIR" ]]; then
  echo "[error] OUTPUT_DIR must be a subdirectory such as dist" >&2; exit 1
fi
```

- [ ] **Step 2: Cleanup only for built static types** — `deploy_app.sh`: change the cleanup condition to
```bash
if [ "$APP_TYPE" = "vite" ] || { [ "$APP_TYPE" = "custom" ] && [ -z "$START_CMD" ]; }; then
```
`setup_app.sh`: change `if [ "$IS_STATIC" = "true" ]; then` guarding the `find … -delete` block to
```bash
if [ "$IS_STATIC" = "true" ] && [ "$RESOLVED_TYPE" != "static" ]; then
```
(the later `IS_STATIC` uses for index.html validation stay as they are).

- [ ] **Step 3: `setup_app.sh` parity with `deploy_app.sh`**
  - Custom commands in subshells: `eval "$INSTALL_CMD"` → `( cd "${WORK_DIR}" && eval "$INSTALL_CMD" )`; `NODE_ENV=production eval "$BUILD_CMD"` → `( cd "${WORK_DIR}" && NODE_ENV=production eval "$BUILD_CMD" )`.
  - Explicit missing root dir: replace the nested-zip block's opening condition
    ```bash
    if [ ! -d "$WORK_DIR" ] || { [ "$ROOT_DIR" = "/" ] && [ ! -f "${WORK_DIR}/package.json" ]; }; then
    ```
    with
    ```bash
    if [ "$ROOT_DIR" != "/" ] && [ ! -d "$WORK_DIR" ]; then
      echo "[error] Root Directory '${ROOT_DIR}' does not exist in the uploaded project." >&2
      echo "[error] Looked for: ${WORK_DIR}" >&2
      echo "[error] Top-level contents:" >&2
      ls -1 "${APP_DIR}" 2>&1 | sed 's/^/[error]   /' >&2
      exit 1
    fi
    if [ "$ROOT_DIR" = "/" ] && [ ! -f "${WORK_DIR}/package.json" ]; then
    ```
    (the rest of the nested-zip block is unchanged).

- [ ] **Step 4: Verify**

```bash
bash -n scripts/deploy_app.sh && bash -n scripts/setup_app.sh && echo "syntax ok"
grep -n 'must be a subdirectory' scripts/deploy_app.sh scripts/setup_app.sh
grep -n 'RESOLVED_TYPE" != "static"' scripts/setup_app.sh
grep -n '( cd "${WORK_DIR}" && ' scripts/setup_app.sh
```
Expected: syntax ok; one hit per script for the subdirectory message; one hit for the static guard; two hits for subshells.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy_app.sh scripts/setup_app.sh
git commit -m "fix(scripts): never wipe output for static apps, reject . and / as OUTPUT_DIR, align setup_app.sh with deploy_app.sh

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 11: Frontend fixes

**Files:**
- Modify: `frontend/src/pages/Apps.tsx`, `Settings.tsx`, `AppDetail.tsx`, `Services.tsx`, `SSL.tsx`, `Redis.tsx`, `Login.tsx`, `Domains.tsx`, `Databases.tsx`

- [ ] **Step 1: Delete confirmation copy** — `Apps.tsx`, the `confirm(...)` in the expanded card: replace the string with
```ts
`Delete ${app.name}? This stops the PM2 process, removes its NGINX configs and deletes /var/www/apps/${app.name}.`
```

- [ ] **Step 2: Settings update flow with refs** — in `Settings()` after `const logRef = …` add:
```ts
  // Refs mirror status/log count so the stream-closed branches below read
  // live values instead of the closure captured when applyUpdate started.
  const statusRef = useRef<UpdateStatus>('idle');
  const logCountRef = useRef(0);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { logCountRef.current = logs.length; }, [logs]);
```
Then in `applyUpdate` replace `if (status === 'updating') {` with `if (statusRef.current === 'updating') {` and `if (status === 'updating' && logs.length > 3) {` with `if (statusRef.current === 'updating' && logCountRef.current > 3) {`. Also set the ref synchronously at the top of `applyUpdate`: after `setStatus('updating');` add `statusRef.current = 'updating';`.

- [ ] **Step 3: Static class map for alert chips** — in `Settings.tsx` replace the `.map(({ id, label, color }) => (` block's class expression. Change the array to:
```ts
            {[
              { id: 'app_crash',   label: 'App Crash',   cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
              { id: 'disk_full',   label: 'Disk Full',   cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
              { id: 'high_memory', label: 'High Memory', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
            ].map(({ id, label, cls }) => (
```
and the className to
```ts
                className={`badge cursor-pointer transition-all ${
                  settings.events.includes(id) ? cls : 'bg-white/5 text-gray-500 border-white/10'
                }`}
```

- [ ] **Step 4: `/8` opacity classes** — mechanical replace in the nine files listed by the audit:
```bash
cd frontend && grep -rlE '(bg|border|text)-[a-z]+-[0-9]+/8\b|border-white/8\b' src | xargs sed -i -E 's#((bg|border|text)-[a-z]+-[0-9]+)/8\b#\1/10#g; s#border-white/8\b#border-white/10#g'
grep -rnE '/8\b' src | grep -E '(bg|border|text)-' || echo "no /8 classes remain"
```
Review the diff (`git diff --stat`) — it must touch only class strings.

- [ ] **Step 5: AppDetail polling** — replace `fetchApp` with:
```ts
  const [pollError, setPollError] = useState('');
  const loadedOnce = useRef(false);

  const fetchApp = useCallback(async () => {
    if (!name) return;
    const res = await api.get<App>(`/apps/${name}`);
    if (res.success && res.data) {
      setApp(res.data);
      setPollError('');
      loadedOnce.current = true;
    } else if (!loadedOnce.current || /not found/i.test(res.error ?? '')) {
      setApp(null);
    } else {
      // Transient failure (network blip, rate limit): keep the last good app.
      setPollError(res.error ?? 'Refresh failed');
    }
    setLoading(false);
  }, [name]);
```
Change the two cron effects' dependency arrays from `[tab, app, fetchCronJobs]` to `[tab, app?.id, fetchCronJobs]` and `fetchCronJobs`'s `useCallback` deps from `[app]` to `[app?.id]` (read `app?.id` inside via a local `const appId = app?.id;` declared above the callback and used in the URL and the guard). Render the banner: directly inside the `<Shell>` at the top of the found-app branch add
```tsx
      {pollError && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          Live data may be stale: {pollError}
        </div>
      )}
```

- [ ] **Step 6: Verify**

```bash
cd frontend && npx tsc -b && npm run build 2>&1 | tail -1 && grep -rnE '(bg|border|text)-[a-z]+-[0-9]+/8\b' src || echo "no /8 classes remain"
```
Expected: tsc silent, `✓ built`, no `/8` classes.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "fix(ui): correct delete copy, update-success stale closure, /8 opacity classes, AppDetail poll resilience

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 12: CI workflow and README badge

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`

- [ ] **Step 1: Workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: backend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version-file: backend/go.mod }
      - run: go vet ./...
      - run: go test ./... -count=1
      - run: go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...

  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci
      - run: npx tsc -b
      - run: npm run build

  scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y shellcheck
      - run: bash -n scripts/*.sh
      - run: shellcheck -S warning scripts/*.sh
        continue-on-error: true
```

- [ ] **Step 2: Badge** — in `README.md`, directly under the `# GoNextjs — Nextjs Control Panel` heading add:
```
[![CI](https://github.com/freddiehdxd/GoNextjs/actions/workflows/ci.yml/badge.svg)](https://github.com/freddiehdxd/GoNextjs/actions/workflows/ci.yml)
```

- [ ] **Step 3: Verify locally** — `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "yaml ok"` (PyYAML is available; if not, `npx --yes yaml-lint .github/workflows/ci.yml`).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: run go vet/test/govulncheck, tsc/build and shellcheck on push and PR

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 13: Merge, push, watch CI (controller)

- [ ] **Step 1:** Full local check in the worktree: `cd backend && go test ./... -count=1` (all `ok` on Windows now), `cd frontend && npx tsc -b && npm run build`.
- [ ] **Step 2:** Present the finishing options (merge / PR / keep) to the user; on merge, fast-forward `main`, remove the worktree, delete the branch.
- [ ] **Step 3:** After the user's go-ahead, `git push origin main` and confirm the Actions run is green (`gh run list --limit 1 && gh run watch`). If `govulncheck` reports a vulnerability in a dependency, note it for sub-project D rather than blocking.

---

## Task 14: History purge and force-push (controller, after Task 13)

**Precondition:** the user chose "Purge and force-push" during design. Confirm once more immediately before the force-push, quoting the old and new `HEAD` SHAs.

- [ ] **Step 1: Install and clone fresh**

```bash
pip install git-filter-repo
cd "$TEMP" && rm -rf panel-purge && git clone https://github.com/freddiehdxd/GoNextjs.git panel-purge && cd panel-purge
OLD_HEAD=$(git rev-parse HEAD); echo "old HEAD $OLD_HEAD"
git log --oneline -- scripts/deploy.py | cat      # expect the one introducing commit (8565268) and the removal commit
```

- [ ] **Step 2: Rewrite**

```bash
git filter-repo --invert-paths --path scripts/deploy.py
git log --all --oneline -- scripts/deploy.py | cat   # expect EMPTY
SECRET=$(git -C /c/Users/User/Documents/panel show 8565268:scripts/deploy.py | grep -oE 'password="[^"]+"' | cut -d'"' -f2)
git grep -I -q -- "$SECRET" $(git rev-list --all) && echo "STILL PRESENT — STOP" || echo "secret absent from all revisions"
unset SECRET
```
(The literal never appears in a report or commit.)

- [ ] **Step 3: Force-push (ask first)** — show `OLD_HEAD` and `git rev-parse HEAD`, get the explicit go-ahead, then:

```bash
git remote add origin https://github.com/freddiehdxd/GoNextjs.git
git push --force origin main
```

- [ ] **Step 4: Resync the working checkout**

```bash
cd /c/Users/User/Documents/panel && git fetch origin && git reset --hard origin/main && git log --oneline -3 && rm -f scripts/fix_embed.py cookies.txt && git status --short
```
Also delete the root `package.json`, `package-lock.json`, `node_modules/`, `backend/panel-server.exe`, `backend/panel-server.exe~` from disk (all untracked/ignored). The `.claude/worktrees/pensive-montalcini` worktree references old SHAs; leave it and tell the user.

- [ ] **Step 5: Report** — old/new HEAD, that the server's self-update copes (`fetch` + `reset --hard origin/main`), that any other clone must re-clone, and that the root password and GitHub token still need rotating by the user.

---

## Self-review notes

- **Spec coverage:** A1 → Tasks 1, 14; A2.1 → 2; A2.2 → 3; A2.3 → 4; A2.4 → 5; A2.5 → 6 (incl. migration 6); A2.6 → 7; A2.7 → 8; A3 → 9, 10; A4 → 11; A5 → 12; testing table → each task's Step "Verify"; manual checks → 13, 14.
- **Naming consistency:** `resolveAppPath`/`insideDir`/`errPathEscape` (2); `AppScriptEnv` (3, used by `apps.go` and `cron.go`); `classifyApp`/`Static` (4); `sslSettings`/`securityHeaders` (5); `normalizeDomain` (6); `runOpts`/`run`/`setProcessGroup`/`scriptTimeout`/`parseDeployTimeout`/`DeployTimeout` (7, `main.go`); lockout line (8, matches `setup_panel.sh` filter regex `Login lockout: IP <HOST> locked`).
- **Windows:** Task 7's process-group test is `!windows`-only and runs on CI; Task 2's symlink subtest skips when not permitted; after Task 6 the suite is green on Windows.
