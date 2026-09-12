# Hardening Batch A Design

**Date:** 2026-09-11
**Status:** Approved
**Scope:** Repo-side security hygiene plus the "this week" fixes from the 2026-09-11 audit. Sub-project A of the audit follow-up (B: async deploys, C: backups, D: upgrades/scripts/docs, E: per-app users/systemd/sessions follow separately).

---

## Overview

The audit found a small number of defects that are each a few lines to fix but individually serious: a file-manager path guard that can be bypassed into sibling app directories, a cron deploy that runs the wrong script, health checks that mark every static app unhealthy, NGINX configs that lie about the scheme and ignore IPv6, a world-readable panel `.env`, a fail2ban jail that can never fire, deploy timeouts that orphan builds, and three visible frontend bugs. It also found secrets committed to a public repository.

This spec fixes all of those in one branch of independent tasks, adds CI so regressions are caught on Linux, and finishes by purging the leaked file from history and force-pushing.

Decisions made during design:

- **History purge is real.** `scripts/deploy.py` is removed from every commit with `git filter-repo`, and `main` is force-pushed. Credential rotation (root password, GitHub token) is the user's action and is out of scope for the code.
- **The purge runs last**, after everything else in this batch is merged, because it rewrites the SHAs of the whole branch.
- **Domain case:** mixed-case input is accepted and normalised to lowercase before validation, storage, NGINX file names and certbot; the existing test that expects rejection is corrected.
- **Static apps are "healthy by definition"** in the health checker (they have no process to probe), reported with `status_code: 0` and `error: ""`, so the dashboard stops showing them as failing.

---

## A1. Secrets and repo hygiene

### `.gitignore`
Add: `cookies.txt`, `*.exe`, `*.exe~`, `frontend/tsconfig.tsbuildinfo`, `.superpowers/`. Remove the `backend/go.sum` line (the file is tracked and must stay tracked). Run `git rm --cached frontend/tsconfig.tsbuildinfo`.

### Stray files
Delete from disk (untracked): `cookies.txt`, `scripts/fix_embed.py`, root `package.json`, root `package-lock.json`, root `node_modules/`, `backend/panel-server.exe`, `backend/panel-server.exe~`. Delete from the tree (tracked): `scripts/deploy.py`, `scripts/deploy_next_app.sh` (see A2.2).

### Dependency patch
`frontend/package.json`: `react-router-dom` `^6.30.6` (fixes the three moderate `npm audit` findings). Lockfile regenerated with `npm install`.

### History purge (final task, after merge)
1. `pip install git-filter-repo` (not installed today).
2. On a fresh clone of the repo (filter-repo refuses to run on a non-fresh clone by default): `git filter-repo --invert-paths --path scripts/deploy.py`.
3. Verify: `git log --all --oneline -- scripts/deploy.py` prints nothing; additionally `git grep -I -- "<the leaked password>" $(git rev-list --all)` prints nothing, where the value is taken from the deleted file at run time and is never written into a spec, plan, report or commit.
4. Re-add `origin` (filter-repo strips remotes), `git push --force origin main`.
5. In the working checkout: `git fetch origin && git reset --hard origin/main`; remove the `.claude/worktrees/pensive-montalcini` worktree only if the user agrees (it is an old Express/Next.js copy; out of scope otherwise).
6. Report the old→new SHA of `HEAD` and tell the user that the server's self-update (`git fetch` + `reset --hard origin/main`) copes, but any other clone must re-clone.

---

## A2. Backend fixes

Each fix has a unit test that fails before and passes after. Tests must run on Windows (`filepath`, `t.TempDir()`, `t.Skip` when symlinks are not permitted).

### A2.1 File manager path guard (`handlers/files.go`)
New helper in `files.go`:

```go
// resolveAppPath returns the absolute path of sub inside appDir, or an error if
// sub escapes appDir (via .., an absolute path, or a symlink). The longest
// existing prefix of the target is resolved with EvalSymlinks so a symlink
// planted inside the app directory cannot point outside it.
func resolveAppPath(appDir, sub string) (string, error)
```

Rules: `filepath.Rel(appDir, target)` must not start with `..`; after `EvalSymlinks` on the deepest existing ancestor, the resolved path must still be inside the resolved `appDir` (prefix `appDir + separator` or equal). Used by `List`, `GetContent`, `SaveContent`, `Upload` (replacing the four inline guards). `Upload` also passes each sanitised filename through it before creating the destination.

`files_test.go`: `TestPathTraversalGuard` rewritten to call `resolveAppPath` on a `t.TempDir()` fixture: accepts `""`, `src`, `src/components/App.tsx`, `..hidden`; rejects `../`, `../otherapp/secrets`, `../../etc/passwd`, `/etc/passwd`, and the sibling-prefix case `../myapp2/.env` when appDir is `<tmp>/myapp`; rejects a symlink inside appDir pointing outside it (skipped if `os.Symlink` fails). `TestSanitizeFilename` "strip windows path" case is made OS-agnostic (expect `filepath.Base` semantics on the host OS, i.e. on Windows `C:\Users\file.txt` → `file.txt`, on Linux the whole string is one segment and is rejected by the regex → `""`); the test computes the expectation via `runtime.GOOS`.

### A2.2 Cron deploy uses `deploy_app.sh` (`services/deploy.go`, `services/cron.go`)
`DeployApp(app, exec, appsDir)` runs `exec.RunScriptEnv("deploy_app.sh", env, name, repo, branch, port, "restart", maxMemory)` where `env` is built by a new exported `services.AppScriptEnv(app *models.App) map[string]string` (`APP_TYPE`, `ROOT_DIR`, `OUTPUT_DIR`, `BUILD_CMD`, `START_CMD`, `INSTALL_CMD`). `handlers/apps.go` `appEnvFromApp` becomes a thin wrapper over it (or is deleted and call sites updated). The cron job query (`tick`, `fetchJob`) selects `app_type, root_dir, output_dir, build_cmd, start_cmd, install_cmd` and populates the `models.App` passed to `DeployApp`. `deploy_next_app.sh` is deleted, removed from `allowedScripts`, the deploy-timeout list, and `executor_test.go`.

Tests: `deploy_test.go` gains a test that `AppScriptEnv` maps every field; `executor_test.go` asserts `deploy_next_app.sh` is no longer allowed and `deploy_app.sh` is.

### A2.3 Health checker skips static apps (`handlers/health.go`)
`checkAll` selects `name, port, app_type, start_cmd`; for `services.IsStaticType(appType, startCmd)` it records `HealthResult{Healthy: true, Error: "", StatusCode: 0}` and continues without probing. `HealthResult` gains `Static bool \`json:"static"\`` so the UI can label it. Test: a pure `classifyApp(appType, startCmd, pm2Status string) (probe bool, result HealthResult)` extracted from the loop and table-tested.

### A2.4 NGINX config correctness (`services/nginx.go`)
All four generated templates (`BuildConfig` ssl/non-ssl, `BuildStaticConfig` ssl/non-ssl):
- add `listen [::]:80;` next to `listen 80;` and `listen [::]:443 ssl http2;` next to `listen 443 ssl http2;`
- HTTP-only proxy template: `proxy_set_header X-Forwarded-Proto $scheme;` (SSL template keeps `https`)
- SSL templates: `ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;`, `ssl_prefer_server_ciphers off;`, `ssl_session_timeout 1d;`, `ssl_session_cache shared:PanelSSL:10m;`, `add_header Strict-Transport-Security "max-age=63072000" always;`, `add_header X-Content-Type-Options nosniff always;`
- static templates: the two `location` blocks that use `add_header Cache-Control` must repeat the two security headers (NGINX `add_header` is not inherited into a block that sets its own).

`nginx_test.go` (new): for each template, assert presence of the `[::]` listeners, the `X-Forwarded-Proto` value, and (SSL) the HSTS line, and absence of `HIGH:!aNULL:!MD5`. `nginx-templates/app.conf.example` is updated to match the generator; `panel.conf.example` is deleted (it documents the pre-rewrite stack; `DEPLOYMENT.md` carries the panel vhost).

### A2.5 Domain normalisation (`handlers/domains.go`, `handlers/ssl.go`, `services/executor.go`)
`domains.Add`, `domains.Remove`, `ssl.Enable`, `ssl.Disable` call `strings.ToLower(strings.TrimSpace(domain))` before validation and use the lowercased value everywhere after. `ValidateDomain` unchanged (it already lowercases for the check). `executor_test.go` `TestValidateDomain/invalid_uppercase_rejected` becomes `mixed_case_accepted` expecting `true`. A new `normalizeDomain(s string) string` in `handlers` is unit-tested.

### A2.6 Executor process groups and configurable deploy timeout (`services/executor.go`, `config/config.go`)
- `config.DeployTimeout time.Duration` from `DEPLOY_TIMEOUT` (Go duration string, default `15m`, minimum `1m`); `NewExecutor` takes it (signature `NewExecutor(scriptsDir, appsDir string, deployTimeout time.Duration)`), `main.go` passes `cfg.DeployTimeout`.
- One private `run(binary string, args []string, extraEnv map[string]string, stdin io.Reader, stdout io.Writer, timeout time.Duration) (*models.ExecResult, error)` replaces the four duplicated bodies (`spawnSafe`, `RunScriptEnv`, `RunBinStream`, `RunBinWithStdin`). Public signatures are unchanged.
- Linux: `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` and `cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }` in `executor_unix.go` (`//go:build !windows`); `executor_windows.go` provides a no-op `setProcessGroup(cmd)` so the package still builds and tests run on the dev machine. `cmd.WaitDelay = 10 * time.Second` on all platforms.
- Test (`executor_test.go`, `//go:build !windows`): run `bash -c 'sleep 30 & wait'` through `run` with a 1s timeout; assert it returns within 3s with code 124. On Windows the test is skipped.

### A2.7 Login lockout log line (`handlers/auth.go`)
`recordFailure` logs `Login lockout: IP <ip> locked for 15 minutes after 5 failed attempts` exactly when the lockout starts. The fail2ban filter in `setup_panel.sh` (`^.*Login lockout: IP <HOST> locked.*$`) already matches this. `auth_test.go` gains a test capturing `log` output via `log.SetOutput` and asserting the line appears on the 5th failure only.

---

## A3. Script fixes

### `scripts/setup_panel.sh`
- Wrap every write to `${PANEL_DIR}/backend/.env` in `( umask 077; cat > … )` and add `chmod 600 "${PANEL_DIR}/backend/.env"` after the last write.
- fail2ban: `[DEFAULT] backend = auto`.
- Hash failure is fatal: the `else` branch that flips to `PANEL_ENV=development` and writes `ADMIN_PASSWORD=` is replaced by `fail "Could not generate the admin password hash; aborting (Go toolchain problem?)"`.
- Pass the password to the hash program via stdin instead of argv.

### `scripts/deploy_app.sh` and `scripts/setup_app.sh`
- `OUTPUT_DIR` validation: additionally reject `.`, `./`, `/` (`[error] OUTPUT_DIR must be a subdirectory such as dist`).
- Output cleanup only when `APP_TYPE`/`RESOLVED_TYPE` is `vite`, or `custom` with no `START_CMD`; never for `static`.
- `setup_app.sh`: custom install/build commands run in a subshell `( cd "${WORK_DIR}" && eval … )` like `deploy_app.sh`; when `ROOT_DIR` is explicitly not `/` and `WORK_DIR` does not exist, fail with the same multi-line error `deploy_app.sh` prints (only the nested-zip fallback applies when `ROOT_DIR` is `/`).
- Both scripts pass `bash -n` and `shellcheck -S warning` with at most pre-existing warnings (CI treats shellcheck as non-blocking in this batch).

---

## A4. Frontend fixes

- `pages/Apps.tsx`: delete confirmation text becomes `Delete ${app.name}? This stops the PM2 process, removes its NGINX configs and deletes /var/www/apps/${app.name}.`
- `pages/Settings.tsx`: `applyUpdate` tracks `sawLog` and `phase` in `useRef`s; the "connection closed" and catch branches read the refs, so a dropped SSE stream after at least one log line reports success and schedules `checkForUpdates`.
- Opacity classes: every `bg-*-500/8`, `border-white/8` (14 sites listed by the audit) → `/10`. `Settings.tsx` alert-event chips use a static map `{ red: 'bg-red-500/10 text-red-400 border-red-500/20', amber: …, orange: … }` instead of template-string class names.
- `pages/AppDetail.tsx`: `fetchApp` sets `app` to `null` only when `res.error` indicates not found (`/not found/i`) or on the initial load; other failures keep the last good `app` and set a transient `pollError` shown as a small banner. The cron-jobs effect and its 30 s interval depend on `app?.id`, not `app`.
- `frontend/src/pages/Dashboard.tsx` and others: no change in this batch.

Verification: `npx tsc -b`, `npm run build`, and a grep asserting zero `/8` opacity classes remain in `frontend/src`.

---

## A5. CI (`.github/workflows/ci.yml`)

Triggers: `push` to `main`, `pull_request`. Jobs on `ubuntu-latest`:
- **backend:** `actions/setup-go` (version from `go.mod`), `go vet ./...`, `go test ./...` (all tests, including the Windows-failing ones, pass on Linux), `govulncheck ./...` (`golang.org/x/vuln/cmd/govulncheck@latest`).
- **frontend:** `actions/setup-node` 22, `npm ci`, `npx tsc -b`, `npm run build`.
- **scripts:** `shellcheck -S warning scripts/*.sh` with `continue-on-error: true` in this batch.

The README gets a CI badge.

---

## Error handling and compatibility

- `NewExecutor` signature change touches `main.go` only.
- `DeployApp` signature unchanged; callers (`cron.go`) pass the fuller `models.App`.
- `HealthResult.Static` is additive JSON; the frontend ignores unknown fields.
- NGINX changes take effect only when a domain config is next written (add domain, enable/disable SSL). No automatic rewrite of existing configs in this batch; a follow-up may add a "regenerate all" action.
- Domain lowercasing: an existing row stored with uppercase would no longer be found by a lowercased lookup. Migration 6: `UPDATE domains SET domain = lower(domain)`; it is idempotent and safe because the column is `UNIQUE` on already-distinct values in practice (if two rows collide the migration fails loudly and the operator resolves it).

---

## Testing summary

| Area | Test |
|---|---|
| files.go | `TestPathTraversalGuard` (real helper, sibling-prefix, symlink), `TestSanitizeFilename` OS-aware |
| deploy.go | `TestAppScriptEnv`; `executor_test.go` allowlist assertions |
| health.go | `TestClassifyApp` table |
| nginx.go | `TestBuildConfigTemplates` |
| domains/ssl | `TestNormalizeDomain`; corrected `TestValidateDomain` |
| executor | `TestRunKillsProcessGroup` (Linux only), existing tests still pass |
| auth.go | `TestLockoutLogsLine` |
| scripts | `bash -n`, shellcheck (non-blocking) |
| frontend | `tsc -b`, `vite build`, zero-`/8` grep |
| CI | workflow runs green on the first PR/push after merge |

Manual: after merge and push, confirm the GitHub Actions run is green; after the history purge, confirm `git log --all -- scripts/deploy.py` is empty on a fresh clone.

---

## Out of scope

- Rotating credentials (user action).
- Async deploys / per-app locks (sub-project B).
- Backup credentials and S3 (sub-project C).
- Dependency major upgrades, script merge, README/DEPLOYMENT rewrite (sub-project D).
- Per-app users, systemd, sliding sessions (sub-project E).
- Regenerating existing NGINX configs on disk.
