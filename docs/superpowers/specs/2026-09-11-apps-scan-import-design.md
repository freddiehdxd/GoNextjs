# Apps Directory Scan & Import Design

**Date:** 2026-09-11
**Status:** Approved
**Scope:** Discover directories in `APPS_DIR` that the panel does not manage, import them as apps, and surface/clean up DB records whose directory is gone.

---

## Overview

An app exists in the panel only if it was created through the panel. Directories that were rsync'd or cloned by hand, and directories left behind when `Create` fails after the deploy script has already run, are invisible everywhere except the Files page (which only lists DB apps). The reverse also happens: an `apps` row can outlive its directory.

This spec adds a scan endpoint that lists both cases, an import endpoint that registers an existing directory as an app **without touching what is running**, a delete endpoint for unwanted directories, and a modal on the Apps page that drives all three.

Decisions made during design:

- **Import adopts as-is.** No script runs on import. A hand-managed PM2 process keeps running; the user can Rebuild/Setup later.
- **Orphaned records are shown with "Remove record"**, which reuses the existing app delete action.
- **Unmanaged directories can be deleted** from the modal, with a typed-name confirmation.

---

## Backend

### Files

| File | Change |
|---|---|
| `backend/internal/handlers/scan.go` | New. `ScanHandler` with `Scan`, `Import`, `DeleteDir`. DB-free helpers as plain functions. |
| `backend/internal/handlers/scan_test.go` | New. Table-driven tests for the helpers. |
| `backend/internal/handlers/apps.go` | Extract `appColumns` (the 17-column select list) and `scanAppRow(row) (*models.App, error)` so `apps.go` and `scan.go` share them. No behaviour change. |
| `backend/main.go` | Register three routes in the protected, compressed JSON group. |
| `frontend/src/lib/api.ts` | Add `ScanResult`, `UnmanagedDir`, `OrphanedApp` types. |
| `frontend/src/components/ScanModal.tsx` | New. |
| `frontend/src/pages/Apps.tsx` | Add "Scan directory" button with count badge; mount `ScanModal`. |

No DB migration.

### `GET /api/apps/scan`

Response:

```json
{
  "apps_dir": "/var/www/apps",
  "unmanaged": [
    {
      "name": "my-site",
      "path": "/var/www/apps/my-site",
      "size_bytes": 1234567,
      "modified_at": "2026-09-01T10:00:00Z",
      "valid_name": true,
      "detected": { "app_type": "vite", "root_dir": "/", "error": "" },
      "detected_port": 3004,
      "git": { "repo_url": "https://github.com/x/y.git", "branch": "main" },
      "pm2": { "status": "online", "port": 3004 },
      "has_env": true,
      "has_ecosystem": true,
      "domains": ["site.example.com"]
    }
  ],
  "orphaned": [
    { "name": "old-app", "port": 3002, "domains": ["old.example.com"], "pm2_status": "stopped" }
  ]
}
```

Rules:

- **Unmanaged** = every entry directly under `cfg.AppsDir` that is a real directory (symlinks and non-directories skipped), whose name does not start with `.`, and whose name is not in `apps`. Listed regardless of whether the name passes `ValidateAppName`; `valid_name` tells the UI whether Import is possible.
- `size_bytes` is a recursive walk that skips `node_modules`, `.git`, `.next`, `dist`, `build` (same exclusion set as detection) so it stays cheap and represents "source size". `modified_at` is the directory's mtime.
- `detected` is `services.DetectAppType(dir, "/")`. On error (`multiple candidates`, unreadable), `app_type` and `root_dir` are empty and `error` carries the message.
- `git` is read directly from disk: `.git/HEAD` gives the branch (`ref: refs/heads/<branch>`; a detached HEAD yields `branch: ""`), `.git/config` gives `[remote "origin"] url`. `null` when `.git` is absent or unreadable. No `git` binary is added to the executor allowlist.
- `detected_port` (top-level integer) is the port found on disk: `ecosystem.config.js` (regex `PORT:\s*['"]?(\d+)`), else `PORT=` in `.env`, else `0`.
- `pm2` matches the directory name against one `pm2.List()` call made once per scan. `null` when no PM2 process has that name; otherwise `status` is the PM2 status and `port` is `detected_port`.
- `domains` is informational: every file in `cfg.NginxAvail` that (a) contains `proxy_pass http://127.0.0.1:<detected_port>;`, or (b) contains an `include <path>;` line whose file contains `server 127.0.0.1:<detected_port>;` (the per-domain upstream include the panel writes since commit `0246e23`), or (c) has a `root <path>` at or under the app directory. `<detected_port>` matching only applies when it is > 0. The file name is the domain.
- **Orphaned** = rows in `apps` whose `filepath.Join(cfg.AppsDir, name)` does not exist. Each carries its port, its domains (from the `domains` table), and the PM2 status for its name from the same `pm2.List()` (`""` if none).
- The PM2 call failing is not fatal: `pm2` fields are `null`/`""` and the scan still returns. Directory read errors on `AppsDir` itself are a 500.

### `POST /api/apps/import`

Request:

```json
{ "name": "my-site", "app_type": "vite", "root_dir": "/", "output_dir": "dist", "port": 3004 }
```

All fields except `name` are optional.

Steps, in order:

1. `name` must pass `ValidateAppName`, the directory must exist under `AppsDir`, and `name` must not already be in `apps` (409 otherwise).
2. `app_type`: if given, must be one of `next|vite|static|node|custom` (`auto`/empty → run detection). If detection fails and no `app_type`/`root_dir` were supplied, respond 400 with the detection error so the UI can ask for a root dir.
3. `root_dir`: given value must start with `/` and not contain `..` (same rule as `Create`); default is the detected root or `/`. `output_dir` defaults to `dist`, must not contain `..` and must not be `.`, `./` or `/` (this is the validation the audit found missing; `Create` gets the same check in this change since the helper is shared).
4. **Port selection:** if `port` given → must be within `[PortStart, PortEnd]` and not used by any `apps` row, else 400. If not given → use `detected_port` when it is in range and free, else `PortAllocator.Allocate`.
5. `env_vars` = `parseEnvFile(<dir>/.env)` merged with `.env.local` overriding (same as `ReadEnvFiles`). Missing files → empty map.
6. `repo_url`/`branch` from the git info; both empty when there is no `.git` (identical to a ZIP-deployed app, so `rebuild` is refused and `setup` works).
7. Write `.panel_meta` with the resolved type and root dir (so a later `syncPanelMeta` agrees).
8. `INSERT INTO apps (...)` using the shared column list, `max_memory`/`max_restarts` at their DB defaults, `build_cmd`/`start_cmd`/`install_cmd` empty.
9. Respond 201 with the app object (same shape as `Create`), plus `"warning"` when a PM2 process exists whose port differs from the chosen one: `"PM2 process is listening on 3004 but the app was registered on 3007; run Setup to align them."`

Nothing on disk changes except `.panel_meta`. No PM2 or NGINX action is taken.

### `DELETE /api/apps/scan/{name}`

- `name` must be a single safe path segment (non-empty, not `.`/`..`, no path separators — directories the scan lists with `valid_name:false` are deletable) and must **not** be in `apps` (managed apps are deleted through the existing action; 409 otherwise).
- Best-effort `pm2 delete <name>`.
- `os.RemoveAll` on the resolved path, guarded the same way as the app delete action (absolute path must have `AppsDir` + separator as prefix).
- 200 `{ "message": "Directory removed" }`; 404 if the directory does not exist.

Orphaned records are removed with the existing `POST /api/apps/{name}/action {"action":"delete"}`; it already tolerates a missing directory.

### Shared refactor in `apps.go`

`List`, `Get`/`getAppByName`, `Create`, `UpdateEnv` each restate the 17-column list and the matching `Scan(...)`. Extract:

```go
const appColumns = "id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd, created_at, updated_at"

func scanAppRow(row pgx.Row) (*models.App, error)   // scans + unmarshals env_vars, sets Domains to empty slice
func validateOutputDir(s string) error               // used by Create and Import
```

`scan.go` uses `appColumns` for the insert's `RETURNING` and `scanAppRow` for the result.

### Routes (`main.go`, protected + compressed group)

```go
r.Get("/apps/scan", scanHandler.Scan)
r.Post("/apps/import", scanHandler.Import)
r.Delete("/apps/scan/{name}", scanHandler.DeleteDir)
```

`/apps/scan` must be registered before `/apps/{name}` is matched for GET; chi matches static segments before parameters, so order in the file does not matter, but the test in §Testing checks it.

---

## Frontend

### Apps page

- A **Scan directory** button next to **New App**. On page load the page calls `GET /apps/scan` once, in parallel with the app list, and shows a badge on the button when `unmanaged.length + orphaned.length > 0` (e.g. "2 unmanaged · 1 orphaned"). No polling; the scan re-runs when the modal opens and after every import/delete/remove.
- The button opens `ScanModal`.

### `ScanModal`

Built on the existing `Modal` component. Two sections; each has its own empty state. If both are empty: "Everything in `/var/www/apps` is managed."

**Unmanaged directories** — one row per entry:

- Name, size, modified date.
- Type badge (same styling as the list's app-type badge) from `detected.app_type`; when `detected.error` is set, show the error text instead of a badge.
- PM2 status dot + port when `pm2` is present; `detected_port` shown as "port 3004 (from ecosystem)" when there is no process.
- Git origin + branch when present.
- Domains when present.
- Small flags: `.env`, `ecosystem.config.js`.
- Actions: **Import**, **Delete**. When `valid_name` is false: no Import, text "Rename the folder to lowercase letters, numbers and hyphens to import it."

**Import** expands the row inline (no nested modal):

- App type dropdown with the same options as New App (`auto`, `next`, `vite`, `static`, `node`, `custom`), prefilled with `detected.app_type` or `auto`.
- Root dir and output dir text inputs, prefilled with `detected.root_dir` / `dist`. Root dir is marked required when `detected.error` is set.
- Port number input prefilled with `pm2.port`, else `detected_port`, else blank (blank = let the server allocate).
- Read-only summary: repo URL (or "no git repository"), number of env vars found.
- Submit → `POST /apps/import`. On success: refresh the app list and the scan, collapse the row, and show the response `warning` (if any) in an amber line at the top of the section for that scan. On error: inline red text under the form.

**Delete** expands the row into a confirm block: "Type `<name>` to delete this directory" with an input; the Delete button is enabled only when the input matches exactly. On success the scan refreshes.

**Orphaned records** — one row per entry: name, port, domains, PM2 status. Action **Remove record**, same typed-name confirm, calling the existing delete action. On success both the app list and the scan refresh.

Loading state is the shared spinner; errors from `/apps/scan` render inline in the modal body.

### Types (`api.ts`)

```ts
export interface DetectedType { app_type: string; root_dir: string; error: string }
export interface UnmanagedDir {
  name: string; path: string; size_bytes: number; modified_at: string;
  valid_name: boolean; detected: DetectedType; detected_port: number;
  git: { repo_url: string; branch: string } | null;
  pm2: { status: string; port: number } | null;
  has_env: boolean; has_ecosystem: boolean; domains: string[];
}
export interface OrphanedApp { name: string; port: number; domains: string[]; pm2_status: string }
export interface ScanResult { apps_dir: string; unmanaged: UnmanagedDir[]; orphaned: OrphanedApp[] }
```

---

## Error handling

| Case | Behaviour |
|---|---|
| `AppsDir` unreadable | 500 from scan; modal shows the error. |
| `pm2 jlist` fails | Scan still succeeds; `pm2` is `null`, `pm2_status` is `""`. |
| Detection error for a directory | Row shows the message; Import requires a root dir. |
| Import name already managed | 409. |
| Import directory missing | 404. |
| Import port taken/out of range | 400 with the reason. |
| Delete of a managed name | 409 ("use the app's Delete action"). |
| Delete path escapes `AppsDir` | 400. |

---

## Testing

**Go, `scan_test.go`, using `t.TempDir()` (no DB):**

- `listUnmanagedDirs`: skips files, dotdirs and symlinks; marks invalid names; excludes names in the managed set.
- `dirSize`: excludes `node_modules`/`.git`/`.next`/`dist`/`build`.
- `readGitInfo`: branch from `ref: refs/heads/x`, detached HEAD → empty branch, origin URL from `.git/config`, missing `.git` → nil.
- `parseEcosystemPort` / `.env` port fallback.
- `findDomainsFor`: matches `proxy_pass` by port and `root` by path, ignores other files.
- `choosePort`: requested valid → used; requested taken or out of range → error; none requested → detected port when free; otherwise allocator.
- `validateOutputDir`: rejects `..`, `.`, `./`, `/`; accepts `dist`, `build/out`.
- Route smoke test with `chi` and `httptest`: `GET /api/apps/scan` reaches the scan handler, not the `{name}` handler (handlers stubbed).

**Handler paths that need a DB** (import conflicts, orphan listing, delete of managed name) are verified manually against the local backend with `APPS_DIR` pointed at a temp folder; the repo has no DB test harness and this change does not add one.

**Frontend:** `tsc -b` passes; manual run against the local backend with a temp `APPS_DIR` containing a vite project, a node project with `ecosystem.config.js`, a folder with an invalid name, and one DB row without a directory.

---

## Out of scope

- Re-attaching found domains to the imported app automatically (they are displayed only).
- Running setup/deploy as part of import.
- Bulk import.
- Detecting apps outside `APPS_DIR`.
