# Apps Directory Scan & Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the panel discover directories in `APPS_DIR` it does not manage, import them as apps without touching what is running, delete unwanted directories, and surface DB records whose directory is gone.

**Architecture:** A new `ScanHandler` (`backend/internal/handlers/scan.go`) exposes `GET /api/apps/scan`, `POST /api/apps/import`, `DELETE /api/apps/scan/{name}`. All filesystem logic (directory listing, size, git info, port detection, NGINX domain matching, port choice) lives in plain functions that are unit-tested with `t.TempDir()` and no database. `apps.go` gets a small shared refactor (`appColumns`, `scanAppRow`, `validateOutputDir`) so the import insert reuses the same column list as `Create`. The frontend adds a `ScanModal` component opened from a new "Scan directory" button on the Apps page.

**Tech Stack:** Go 1.22 (chi, pgx), PostgreSQL, React 18 + TypeScript + Vite, Tailwind 3, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-11-apps-scan-import-design.md`

## Global Constraints

- Import never runs a script, never touches PM2 or NGINX; the only disk write is `<dir>/.panel_meta`.
- App names must pass `services.ValidateAppName` (`^[a-z0-9][a-z0-9-]{0,62}$`).
- `root_dir` must start with `/` and must not contain `..`. `output_dir` must not contain `..` and must not be `.`, `./` or `/`.
- Ports must be within `[cfg.PortStart, cfg.PortEnd]` (defaults 3001–3999) and unused by any `apps` row.
- Directory size and detection skip `node_modules`, `.git`, `.next`, `dist`, `build`.
- No new binaries in the executor allowlist; git info is read from `.git/HEAD` and `.git/config` directly.
- Managed apps cannot be deleted through the scan delete endpoint (409); unmanaged dirs cannot be deleted through the app delete action.
- All Go tests must run on Windows (the dev machine) and Linux: use `filepath`, `t.TempDir()`, and `t.Skip` when `os.Symlink` is not permitted.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Pre-existing test failures on Windows (`TestPathTraversalGuard`, `TestValidateDomain/invalid_uppercase_rejected`) are NOT part of this work; run new tests with `-run` filters and check `go build ./...` + `go vet ./...` instead of requiring the whole suite green on Windows.

---

## File Map

| File | Change |
|---|---|
| `backend/internal/handlers/apps.go` | Add `appColumns` const, `scanAppRow`, `validateOutputDir`; use them in `List`, `getAppByName`, `Create`, `UpdateEnv`. |
| `backend/internal/handlers/apps_test.go` | New. Tests for `validateOutputDir`. |
| `backend/internal/services/port.go` | Add `UsedPorts(ctx)`; `Allocate` uses it. |
| `backend/internal/handlers/scan.go` | New. Types, pure helpers, `ScanHandler` with `Scan`, `Import`, `DeleteDir`. |
| `backend/internal/handlers/scan_test.go` | New. Table-driven tests for all helpers + route smoke test. |
| `backend/main.go` | Construct `ScanHandler`, register 3 routes. |
| `frontend/src/lib/api.ts` | Add `DetectedType`, `UnmanagedDir`, `OrphanedApp`, `ScanResult`. |
| `frontend/src/components/ScanModal.tsx` | New. |
| `frontend/src/pages/Apps.tsx` | "Scan directory" button + badge; mount `ScanModal`. |
| `README.md` | Add the 3 routes to the API list. |

---

## Task 0: Sync and branch

**Files:** none

- [ ] **Step 1: Bring local main up to date (it is 2 commits behind origin)**

```bash
cd C:/Users/User/Documents/panel
git status --short          # expect only untracked junk (cookies.txt, *.exe, package.json, scripts/fix_embed.py) and M frontend/tsconfig.tsbuildinfo
git pull --rebase origin main
git log --oneline -3        # expect: docs: add apps directory scan & import design spec on top of fb0750b, 0246e23
```

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b feat/apps-scan-import
```

- [ ] **Step 3: Confirm the backend still builds after the pull**

```bash
cd backend && go build ./... && go vet ./... && cd ..
```
Expected: no output.

---

## Task 1: Shared helpers in `apps.go` (`appColumns`, `scanAppRow`, `validateOutputDir`)

**Files:**
- Modify: `backend/internal/handlers/apps.go`
- Create: `backend/internal/handlers/apps_test.go`

**Interfaces:**
- Produces:
  - `const appColumns string` — the 17-column select list.
  - `func scanAppRow(row pgx.Row) (*models.App, error)` — scans one row selected with `appColumns`, unmarshals `env_vars`, sets `Domains` to an empty slice.
  - `func validateOutputDir(s string) error` — returns an error for `..`, `.`, `./`, `/`, empty is allowed by callers only after defaulting to `dist`.

- [ ] **Step 1: Write the failing test for `validateOutputDir`**

Create `backend/internal/handlers/apps_test.go`:

```go
package handlers

import "testing"

func TestValidateOutputDir(t *testing.T) {
	tests := []struct {
		in   string
		want bool // true = valid
	}{
		{"dist", true},
		{"build/out", true},
		{"public", true},
		{"..", false},
		{"../x", false},
		{"a/../b", false},
		{".", false},
		{"./", false},
		{"/", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			err := validateOutputDir(tt.in)
			if (err == nil) != tt.want {
				t.Errorf("validateOutputDir(%q) err=%v, want valid=%v", tt.in, err, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/handlers/ -run TestValidateOutputDir -v
```
Expected: compile error `undefined: validateOutputDir`.

- [ ] **Step 3: Add the helpers to `apps.go`**

At the top of `backend/internal/handlers/apps.go`, add `"github.com/jackc/pgx/v5"` to the imports. Then, directly below the `var ( repoURLPattern … branchPattern … )` block, add:

```go
// appColumns is the canonical column list for selecting an App. Every query
// that returns an App must select exactly these columns in this order and
// scan with scanAppRow.
const appColumns = "id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd, created_at, updated_at"

// scanAppRow scans one row selected with appColumns into an App.
// pgx.Rows also satisfies pgx.Row, so this works inside rows.Next() loops.
func scanAppRow(row pgx.Row) (*models.App, error) {
	var app models.App
	var envJSON []byte
	if err := row.Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&envJSON, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts,
		&app.AppType, &app.BuildCmd, &app.StartCmd, &app.RootDir, &app.OutputDir, &app.InstallCmd,
		&app.CreatedAt, &app.UpdatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(envJSON, &app.EnvVars); err != nil || app.EnvVars == nil {
		app.EnvVars = make(map[string]string)
	}
	app.Domains = make([]models.Domain, 0)
	return &app, nil
}

// validateOutputDir rejects output directories that would escape the app's
// working directory or point at the working directory itself.
func validateOutputDir(s string) error {
	if s == "" || s == "." || s == "./" || s == "/" {
		return fmt.Errorf("output_dir must be a subdirectory such as dist")
	}
	if strings.Contains(s, "..") {
		return fmt.Errorf("output_dir must not contain ..")
	}
	return nil
}
```

- [ ] **Step 4: Use the helpers at the four call sites**

In `List`, replace the query string and the scan loop:

```go
	rows, err := h.db.Query(ctx, "SELECT "+appColumns+" FROM apps ORDER BY created_at DESC")
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch apps")
		return
	}
	defer rows.Close()

	apps := make([]models.App, 0)
	for rows.Next() {
		app, err := scanAppRow(rows)
		if err != nil {
			Error(w, http.StatusInternalServerError, "Failed to scan app")
			return
		}
		apps = append(apps, *app)
	}
```
(delete the old `var app models.App / var envJSON []byte / rows.Scan(...) / json.Unmarshal / app.Domains = …` lines inside that loop.)

In `Create`, after the `root_dir` validation block, add:

```go
	if err := validateOutputDir(body.OutputDir); err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return
	}
```

and replace the INSERT so it reads:

```go
	envJSON, _ := json.Marshal(body.EnvVars)
	app, err := scanAppRow(h.db.QueryRow(ctx,
		`INSERT INTO apps (name, repo_url, branch, port, env_vars, app_type, build_cmd, start_cmd, root_dir, output_dir, install_cmd)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 RETURNING `+appColumns,
		body.Name, body.RepoURL, body.Branch, port, envJSON,
		resolvedType, body.BuildCmd, body.StartCmd, resolvedRoot, body.OutputDir, body.InstallCmd,
	))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to save app")
		return
	}

	SuccessCreated(w, app)
```
(delete the old `var app models.App / var envBytes []byte / .Scan(...) / json.Unmarshal(envBytes…) / app.Domains = …` lines.)

In `UpdateEnv`, replace the UPDATE…RETURNING + scan with:

```go
	envJSON, _ := json.Marshal(body.EnvVars)
	app, err := scanAppRow(h.db.QueryRow(ctx,
		`UPDATE apps SET env_vars = $1, updated_at = NOW() WHERE name = $2 RETURNING `+appColumns,
		envJSON, name,
	))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update env vars")
		return
	}
```
(delete the old `var app models.App / var envBytes []byte / .Scan / json.Unmarshal / app.Domains` lines; keep everything after, from `// Write .env file` on.)

In `getAppByName`, replace the first query + scan + unmarshal block with:

```go
	app, err := scanAppRow(h.db.QueryRow(ctx,
		"SELECT "+appColumns+" FROM apps WHERE name = $1", name))
	if err != nil {
		return nil, err
	}
```
Keep the `// Load domains` block that follows unchanged (it appends to `app.Domains`), and keep `return app, nil` — note `app` is now already a pointer, so change the final `return &app, nil` to `return app, nil`.

- [ ] **Step 5: Build, vet, test**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run TestValidateOutputDir -v
```
Expected: build/vet silent; `--- PASS` for all 10 subtests.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handlers/apps.go backend/internal/handlers/apps_test.go
git commit -m "refactor(apps): share app column list and row scanner; validate output_dir

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Scan helpers — directory listing and size

**Files:**
- Create: `backend/internal/handlers/scan.go`
- Create: `backend/internal/handlers/scan_test.go`

**Interfaces:**
- Produces:
  - `var scanExcludedDirs = map[string]bool{"node_modules", ".git", ".next", "dist", "build"}` (all `true`)
  - `func listUnmanagedDirs(appsDir string, managed map[string]bool) ([]string, error)` — sorted names of real, non-dot directories not in `managed`.
  - `func dirSize(root string) int64` — bytes of regular files under `root`, skipping `scanExcludedDirs`.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/handlers/scan_test.go`:

```go
package handlers

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestListUnmanagedDirs(t *testing.T) {
	root := t.TempDir()
	mkdir(t, filepath.Join(root, "alpha"))
	mkdir(t, filepath.Join(root, "beta"))
	mkdir(t, filepath.Join(root, "Bad_Name"))
	mkdir(t, filepath.Join(root, ".hidden"))
	writeFile(t, filepath.Join(root, "notes.txt"), "x")

	// Symlinked directory must be skipped (skip test if symlinks unsupported, e.g. Windows without privilege)
	linkTarget := t.TempDir()
	symlinkOK := os.Symlink(linkTarget, filepath.Join(root, "linked")) == nil

	got, err := listUnmanagedDirs(root, map[string]bool{"beta": true})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Bad_Name", "alpha"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if symlinkOK {
		for _, n := range got {
			if n == "linked" {
				t.Errorf("symlinked dir must be skipped")
			}
		}
	}
}

func TestListUnmanagedDirsMissingRoot(t *testing.T) {
	_, err := listUnmanagedDirs(filepath.Join(t.TempDir(), "nope"), nil)
	if err == nil {
		t.Error("expected error for missing apps dir")
	}
}

func TestDirSize(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), "12345")            // 5
	writeFile(t, filepath.Join(root, "src", "b.txt"), "123")        // 3
	writeFile(t, filepath.Join(root, "node_modules", "x.js"), "xxxxxxxxxx") // excluded
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "xxxxxxxxxx")         // excluded
	writeFile(t, filepath.Join(root, "dist", "i.html"), "xxxxxxxxxx")       // excluded
	if got := dirSize(root); got != 8 {
		t.Errorf("dirSize = %d, want 8", got)
	}
	if got := dirSize(filepath.Join(root, "missing")); got != 0 {
		t.Errorf("dirSize(missing) = %d, want 0", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run 'TestListUnmanagedDirs|TestDirSize' -v
```
Expected: compile error `undefined: listUnmanagedDirs`.

- [ ] **Step 3: Create `scan.go` with the two helpers**

```go
package handlers

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// scanExcludedDirs are skipped when sizing directories (same set detect.go ignores).
var scanExcludedDirs = map[string]bool{
	"node_modules": true, ".git": true, ".next": true, "dist": true, "build": true,
}

// listUnmanagedDirs returns the sorted names of real directories directly under
// appsDir that are not dot-directories, not symlinks, and not in managed.
func listUnmanagedDirs(appsDir string, managed map[string]bool) ([]string, error) {
	entries, err := os.ReadDir(appsDir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") || managed[name] {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

// dirSize sums regular-file sizes under root, skipping scanExcludedDirs.
// Returns 0 if root is missing or unreadable.
func dirSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() {
			if path != root && scanExcludedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if info, err := d.Info(); err == nil && info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total
}
```

Note: `os.ReadDir` reports a symlink-to-directory with `e.IsDir() == false` and `ModeSymlink` set, so the symlink check is belt-and-braces.

- [ ] **Step 4: Run the tests**

```bash
cd backend && go test ./internal/handlers/ -run 'TestListUnmanagedDirs|TestDirSize' -v
```
Expected: PASS ×3.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/scan.go backend/internal/handlers/scan_test.go
git commit -m "feat(scan): list unmanaged directories and compute source size

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Scan helpers — git info and port detection

**Files:**
- Modify: `backend/internal/handlers/scan.go`
- Modify: `backend/internal/handlers/scan_test.go`

**Interfaces:**
- Produces:
  - `type GitInfo struct { RepoURL string `json:"repo_url"`; Branch string `json:"branch"` }`
  - `func readGitInfo(dir string) *GitInfo` — nil when `.git/HEAD` is missing.
  - `func parseEcosystemPort(content string) int` — 0 when absent.
  - `func detectPort(dir string) int` — ecosystem.config.js first, then `PORT=` in `.env`, else 0.
- Consumes: `parseEnvFile(path string) (map[string]string, error)` from `apps.go`.

- [ ] **Step 1: Append failing tests to `scan_test.go`**

```go
func TestReadGitInfo(t *testing.T) {
	t.Run("branch and origin", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".git", "HEAD"), "ref: refs/heads/develop\n")
		writeFile(t, filepath.Join(dir, ".git", "config"), `[core]
	repositoryformatversion = 0
[remote "origin"]
	url = https://github.com/acme/site.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "develop"]
	remote = origin
`)
		got := readGitInfo(dir)
		if got == nil || got.RepoURL != "https://github.com/acme/site.git" || got.Branch != "develop" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("detached head, no origin", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
		writeFile(t, filepath.Join(dir, ".git", "config"), "[core]\n\tbare = false\n")
		got := readGitInfo(dir)
		if got == nil || got.RepoURL != "" || got.Branch != "" {
			t.Errorf("got %+v, want empty fields", got)
		}
	})
	t.Run("no .git", func(t *testing.T) {
		if got := readGitInfo(t.TempDir()); got != nil {
			t.Errorf("got %+v, want nil", got)
		}
	})
}

func TestParseEcosystemPort(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"env: {\n      NODE_ENV: 'production',\n      PORT:     '3004',\n    },", 3004},
		{`PORT: "3010"`, 3010},
		{"PORT: 3011,", 3011},
		{"name: 'x'", 0},
		{"", 0},
	}
	for _, tt := range tests {
		if got := parseEcosystemPort(tt.in); got != tt.want {
			t.Errorf("parseEcosystemPort(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestDetectPort(t *testing.T) {
	t.Run("ecosystem wins over env", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "ecosystem.config.js"), "module.exports={apps:[{env:{PORT:'3004'}}]}")
		writeFile(t, filepath.Join(dir, ".env"), "PORT=3999\n")
		if got := detectPort(dir); got != 3004 {
			t.Errorf("got %d, want 3004", got)
		}
	})
	t.Run("env fallback", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".env"), "FOO=bar\nPORT=\"3020\"\n")
		if got := detectPort(dir); got != 3020 {
			t.Errorf("got %d, want 3020", got)
		}
	})
	t.Run("nothing", func(t *testing.T) {
		if got := detectPort(t.TempDir()); got != 0 {
			t.Errorf("got %d, want 0", got)
		}
	})
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run 'TestReadGitInfo|TestParseEcosystemPort|TestDetectPort' -v
```
Expected: compile error `undefined: readGitInfo`.

- [ ] **Step 3: Implement in `scan.go`**

Add `"bufio"`, `"regexp"`, `"strconv"` to the imports, then append:

```go
// GitInfo is what the scan reports about a directory's git checkout.
type GitInfo struct {
	RepoURL string `json:"repo_url"`
	Branch  string `json:"branch"`
}

// readGitInfo reads .git/HEAD and .git/config directly. Returns nil when the
// directory is not a git checkout. Detached HEAD yields Branch == "".
func readGitInfo(dir string) *GitInfo {
	headData, err := os.ReadFile(filepath.Join(dir, ".git", "HEAD"))
	if err != nil {
		return nil
	}
	info := &GitInfo{}
	head := strings.TrimSpace(string(headData))
	if strings.HasPrefix(head, "ref: refs/heads/") {
		info.Branch = strings.TrimPrefix(head, "ref: refs/heads/")
	}

	cfg, err := os.Open(filepath.Join(dir, ".git", "config"))
	if err != nil {
		return info
	}
	defer cfg.Close()

	inOrigin := false
	scanner := bufio.NewScanner(cfg)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			inOrigin = line == `[remote "origin"]`
			continue
		}
		if inOrigin && strings.HasPrefix(line, "url") {
			if _, val, ok := strings.Cut(line, "="); ok {
				info.RepoURL = strings.TrimSpace(val)
				break
			}
		}
	}
	return info
}

var ecosystemPortRe = regexp.MustCompile(`PORT:\s*['"]?(\d+)`)

// parseEcosystemPort extracts the PORT value from ecosystem.config.js content.
func parseEcosystemPort(content string) int {
	m := ecosystemPortRe.FindStringSubmatch(content)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// detectPort returns the port a directory appears to use: ecosystem.config.js
// first, then PORT= in .env, else 0.
func detectPort(dir string) int {
	if data, err := os.ReadFile(filepath.Join(dir, "ecosystem.config.js")); err == nil {
		if p := parseEcosystemPort(string(data)); p > 0 {
			return p
		}
	}
	if vars, err := parseEnvFile(filepath.Join(dir, ".env")); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(vars["PORT"])); err == nil && n > 0 {
			return n
		}
	}
	return 0
}
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && go test ./internal/handlers/ -run 'TestReadGitInfo|TestParseEcosystemPort|TestDetectPort' -v
```
Expected: PASS for all subtests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/scan.go backend/internal/handlers/scan_test.go
git commit -m "feat(scan): read git origin/branch and detect port from disk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: Scan helpers — NGINX domain matching and port choice

**Files:**
- Modify: `backend/internal/handlers/scan.go`
- Modify: `backend/internal/handlers/scan_test.go`
- Modify: `backend/internal/services/port.go`

**Interfaces:**
- Produces:
  - `func findDomainsFor(availDir string, port int, dirPath string) []string` — sorted file names in `availDir` whose content proxies to `port` (when `port > 0`) or has a `root` at/under `dirPath`.
  - `func choosePort(requested, detected int, used map[int]bool, start, end int) (int, error)`.
  - `func (pa *PortAllocator) UsedPorts(ctx context.Context) (map[int]bool, error)` in `services/port.go`.

- [ ] **Step 1: Append failing tests to `scan_test.go`**

```go
func TestFindDomainsFor(t *testing.T) {
	avail := t.TempDir()
	appDir := filepath.Join(string(filepath.Separator)+"var", "www", "apps", "site")
	writeFile(t, filepath.Join(avail, "proxy.example.com"),
		"server {\n    location / {\n        proxy_pass http://127.0.0.1:3004;\n    }\n}\n")
	writeFile(t, filepath.Join(avail, "static.example.com"),
		"server {\n    root "+filepath.Join(appDir, "dist")+";\n}\n")
	writeFile(t, filepath.Join(avail, "exact.example.com"),
		"server {\n    root "+appDir+";\n}\n")
	writeFile(t, filepath.Join(avail, "other.example.com"),
		"server {\n    proxy_pass http://127.0.0.1:3005;\n    root /var/www/apps/site2/dist;\n}\n")
	mkdir(t, filepath.Join(avail, "subdir")) // directories are ignored

	got := findDomainsFor(avail, 3004, appDir)
	want := []string{"exact.example.com", "proxy.example.com", "static.example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}

	// port 0 must not match anything by port
	got = findDomainsFor(avail, 0, filepath.Join(appDir, "nomatch"))
	if len(got) != 0 {
		t.Errorf("got %v, want none", got)
	}

	// missing dir → empty, no panic
	if got := findDomainsFor(filepath.Join(avail, "missing"), 3004, appDir); len(got) != 0 {
		t.Errorf("got %v, want none", got)
	}
}

func TestChoosePort(t *testing.T) {
	used := map[int]bool{3001: true, 3002: true, 3004: true}
	tests := []struct {
		name      string
		requested int
		detected  int
		want      int
		wantErr   bool
	}{
		{"requested free", 3010, 0, 3010, false},
		{"requested taken", 3002, 0, 0, true},
		{"requested below range", 3000, 0, 0, true},
		{"requested above range", 4000, 0, 0, true},
		{"detected free", 0, 3007, 3007, false},
		{"detected taken falls back to first free", 0, 3004, 3003, false},
		{"detected out of range falls back", 0, 8080, 3003, false},
		{"nothing given", 0, 0, 3003, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := choosePort(tt.requested, tt.detected, used, 3001, 3999)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
	t.Run("range exhausted", func(t *testing.T) {
		if _, err := choosePort(0, 0, map[int]bool{3001: true, 3002: true}, 3001, 3002); err == nil {
			t.Error("expected error when no free port")
		}
	})
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run 'TestFindDomainsFor|TestChoosePort' -v
```
Expected: compile error `undefined: findDomainsFor`.

- [ ] **Step 3: Implement in `scan.go`**

Add `"fmt"` to the imports and append:

```go
// findDomainsFor returns the names of NGINX site files in availDir that proxy
// to port (when port > 0) or serve a root at or under dirPath.
func findDomainsFor(availDir string, port int, dirPath string) []string {
	entries, err := os.ReadDir(availDir)
	if err != nil {
		return []string{}
	}
	proxyNeedle := ""
	if port > 0 {
		proxyNeedle = fmt.Sprintf("proxy_pass http://127.0.0.1:%d;", port)
	}
	cleanDir := filepath.Clean(dirPath)
	matches := []string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(availDir, e.Name()))
		if err != nil {
			continue
		}
		content := string(data)
		if proxyNeedle != "" && strings.Contains(content, proxyNeedle) {
			matches = append(matches, e.Name())
			continue
		}
		for _, line := range strings.Split(content, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "root ") {
				continue
			}
			root := filepath.Clean(strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "root ")), ";"))
			if root == cleanDir || strings.HasPrefix(root, cleanDir+string(filepath.Separator)) {
				matches = append(matches, e.Name())
				break
			}
		}
	}
	sort.Strings(matches)
	return matches
}

// choosePort picks the port for an imported app.
//   - requested != 0: must be in range and unused, else error.
//   - else detected, when in range and unused.
//   - else the first free port in range.
func choosePort(requested, detected int, used map[int]bool, start, end int) (int, error) {
	inRange := func(p int) bool { return p >= start && p <= end }
	if requested != 0 {
		if !inRange(requested) {
			return 0, fmt.Errorf("port %d is outside the allowed range %d-%d", requested, start, end)
		}
		if used[requested] {
			return 0, fmt.Errorf("port %d is already used by another app", requested)
		}
		return requested, nil
	}
	if detected != 0 && inRange(detected) && !used[detected] {
		return detected, nil
	}
	for p := start; p <= end; p++ {
		if !used[p] {
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free ports available in range %d-%d", start, end)
}
```

- [ ] **Step 4: Add `UsedPorts` to `services/port.go` and use it in `Allocate`**

Replace the body of `Allocate` and add the new method so the file's methods read:

```go
// UsedPorts returns the set of ports currently assigned to apps.
func (pa *PortAllocator) UsedPorts(ctx context.Context) (map[int]bool, error) {
	rows, err := pa.db.Query(ctx, "SELECT port FROM apps")
	if err != nil {
		return nil, fmt.Errorf("query ports: %w", err)
	}
	defer rows.Close()

	used := make(map[int]bool)
	for rows.Next() {
		var port int
		if err := rows.Scan(&port); err != nil {
			return nil, fmt.Errorf("scan port: %w", err)
		}
		used[port] = true
	}
	return used, nil
}

// Allocate finds and returns the next free port
func (pa *PortAllocator) Allocate(ctx context.Context) (int, error) {
	usedPorts, err := pa.UsedPorts(ctx)
	if err != nil {
		return 0, err
	}
	for port := pa.portStart; port <= pa.portEnd; port++ {
		if !usedPorts[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free ports available in range %d-%d", pa.portStart, pa.portEnd)
}
```

- [ ] **Step 5: Run tests, build, vet**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run 'TestFindDomainsFor|TestChoosePort' -v
```
Expected: PASS for all subtests; build/vet silent.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handlers/scan.go backend/internal/handlers/scan_test.go backend/internal/services/port.go
git commit -m "feat(scan): match NGINX domains and choose import port

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: `ScanHandler.Scan` + routes

**Files:**
- Modify: `backend/internal/handlers/scan.go`
- Modify: `backend/internal/handlers/scan_test.go`
- Modify: `backend/main.go`

**Interfaces:**
- Produces:
  - `type ScanHandler struct` and `func NewScanHandler(db *services.DB, pm2 *services.PM2, port *services.PortAllocator, cfg *config.Config) *ScanHandler`
  - `func (h *ScanHandler) Scan(w, r)` — `GET /api/apps/scan`
  - Response types `DetectedType`, `PM2Info`, `UnmanagedDir`, `OrphanedApp`, `ScanResult` (JSON exactly as in the spec).
  - `func (h *ScanHandler) pm2StatusMap() map[string]string` — name → status, empty on error.
- Consumes: `listUnmanagedDirs`, `dirSize`, `readGitInfo`, `detectPort`, `findDomainsFor`, `services.DetectAppType`, `services.ValidateAppName`.

- [ ] **Step 1: Write the failing route smoke test**

Append to `scan_test.go` (add `"net/http"`, `"net/http/httptest"`, and `"github.com/go-chi/chi/v5"` to its imports):

```go
// TestScanRouteNotShadowed guards the route layout in main.go: /apps/scan must
// hit the scan handler, not /apps/{name}.
func TestScanRouteNotShadowed(t *testing.T) {
	r := chi.NewRouter()
	hit := ""
	r.Get("/apps/{name}", func(w http.ResponseWriter, r *http.Request) { hit = "app:" + chi.URLParam(r, "name") })
	r.Get("/apps/scan", func(w http.ResponseWriter, r *http.Request) { hit = "scan" })
	r.Delete("/apps/scan/{name}", func(w http.ResponseWriter, r *http.Request) { hit = "del:" + chi.URLParam(r, "name") })

	req := httptest.NewRequest("GET", "/apps/scan", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if hit != "scan" {
		t.Errorf("GET /apps/scan hit %q, want scan", hit)
	}
	req = httptest.NewRequest("GET", "/apps/myapp", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if hit != "app:myapp" {
		t.Errorf("GET /apps/myapp hit %q, want app:myapp", hit)
	}
	req = httptest.NewRequest("DELETE", "/apps/scan/old", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if hit != "del:old" {
		t.Errorf("DELETE /apps/scan/old hit %q, want del:old", hit)
	}
}

func TestScanResultJSONShape(t *testing.T) {
	res := ScanResult{
		AppsDir:   "/var/www/apps",
		Unmanaged: []UnmanagedDir{},
		Orphaned:  []OrphanedApp{},
	}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"apps_dir":"/var/www/apps","unmanaged":[],"orphaned":[]}`
	if string(data) != want {
		t.Errorf("got %s\nwant %s", data, want)
	}
}
```
(also add `"encoding/json"` to the test imports.)

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run 'TestScanRouteNotShadowed|TestScanResultJSONShape' -v
```
Expected: compile error `undefined: ScanResult`.

- [ ] **Step 3: Add types and the handler to `scan.go`**

Extend the imports to:

```go
import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"panel-backend/internal/config"
	"panel-backend/internal/services"
)
```

Append:

```go
// ---- Response types (JSON shape is part of the API; see spec) ----

type DetectedType struct {
	AppType string `json:"app_type"`
	RootDir string `json:"root_dir"`
	Error   string `json:"error"`
}

type PM2Info struct {
	Status string `json:"status"`
	Port   int    `json:"port"`
}

type UnmanagedDir struct {
	Name         string       `json:"name"`
	Path         string       `json:"path"`
	SizeBytes    int64        `json:"size_bytes"`
	ModifiedAt   time.Time    `json:"modified_at"`
	ValidName    bool         `json:"valid_name"`
	Detected     DetectedType `json:"detected"`
	DetectedPort int          `json:"detected_port"`
	Git          *GitInfo     `json:"git"`
	PM2          *PM2Info     `json:"pm2"`
	HasEnv       bool         `json:"has_env"`
	HasEcosystem bool         `json:"has_ecosystem"`
	Domains      []string     `json:"domains"`
}

type OrphanedApp struct {
	Name      string   `json:"name"`
	Port      int      `json:"port"`
	Domains   []string `json:"domains"`
	PM2Status string   `json:"pm2_status"`
}

type ScanResult struct {
	AppsDir   string         `json:"apps_dir"`
	Unmanaged []UnmanagedDir `json:"unmanaged"`
	Orphaned  []OrphanedApp  `json:"orphaned"`
}

// ScanHandler discovers unmanaged directories and orphaned app records.
type ScanHandler struct {
	db   *services.DB
	pm2  *services.PM2
	port *services.PortAllocator
	cfg  *config.Config
}

// NewScanHandler creates a scan handler.
func NewScanHandler(db *services.DB, pm2 *services.PM2, port *services.PortAllocator, cfg *config.Config) *ScanHandler {
	return &ScanHandler{db: db, pm2: pm2, port: port, cfg: cfg}
}

// pm2StatusMap returns name → PM2 status. Empty map when PM2 is unavailable.
func (h *ScanHandler) pm2StatusMap() map[string]string {
	m := make(map[string]string)
	list, err := h.pm2.List()
	if err != nil {
		return m
	}
	for _, p := range list {
		m[p.Name] = p.Status
	}
	return m
}

// managedApp is the subset of an apps row the scan needs.
type managedApp struct {
	id   string
	name string
	port int
}

// loadManaged returns all apps rows and a map of app_id → domain names.
func (h *ScanHandler) loadManaged(ctx context.Context) ([]managedApp, map[string][]string, error) {
	rows, err := h.db.Query(ctx, "SELECT id, name, port FROM apps ORDER BY name")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var apps []managedApp
	for rows.Next() {
		var a managedApp
		if err := rows.Scan(&a.id, &a.name, &a.port); err != nil {
			return nil, nil, err
		}
		apps = append(apps, a)
	}

	domains := make(map[string][]string)
	dRows, err := h.db.Query(ctx, "SELECT app_id, domain FROM domains ORDER BY domain")
	if err == nil {
		defer dRows.Close()
		for dRows.Next() {
			var appID, domain string
			if dRows.Scan(&appID, &domain) == nil {
				domains[appID] = append(domains[appID], domain)
			}
		}
	}
	return apps, domains, nil
}

// Scan handles GET /api/apps/scan
func (h *ScanHandler) Scan(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	apps, domainsByApp, err := h.loadManaged(ctx)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to load apps")
		return
	}
	managed := make(map[string]bool, len(apps))
	for _, a := range apps {
		managed[a.name] = true
	}

	names, err := listUnmanagedDirs(h.cfg.AppsDir, managed)
	if err != nil {
		Error(w, http.StatusInternalServerError, fmt.Sprintf("Cannot read %s: %v", h.cfg.AppsDir, err))
		return
	}

	pm2Status := h.pm2StatusMap()

	result := ScanResult{
		AppsDir:   h.cfg.AppsDir,
		Unmanaged: make([]UnmanagedDir, 0, len(names)),
		Orphaned:  make([]OrphanedApp, 0),
	}

	for _, name := range names {
		dir := filepath.Join(h.cfg.AppsDir, name)
		u := UnmanagedDir{
			Name:      name,
			Path:      dir,
			SizeBytes: dirSize(dir),
			ValidName: services.ValidateAppName(name),
			Git:       readGitInfo(dir),
			Domains:   []string{},
		}
		if info, err := os.Stat(dir); err == nil {
			u.ModifiedAt = info.ModTime()
		}
		if meta, err := services.DetectAppType(dir, "/"); err != nil {
			u.Detected = DetectedType{Error: err.Error()}
		} else {
			u.Detected = DetectedType{AppType: meta.AppType, RootDir: meta.RootDir}
		}
		u.DetectedPort = detectPort(dir)
		if status, ok := pm2Status[name]; ok {
			u.PM2 = &PM2Info{Status: status, Port: u.DetectedPort}
		}
		_, envErr := os.Stat(filepath.Join(dir, ".env"))
		u.HasEnv = envErr == nil
		_, ecoErr := os.Stat(filepath.Join(dir, "ecosystem.config.js"))
		u.HasEcosystem = ecoErr == nil
		u.Domains = findDomainsFor(h.cfg.NginxAvail, u.DetectedPort, dir)
		result.Unmanaged = append(result.Unmanaged, u)
	}

	for _, a := range apps {
		if _, err := os.Stat(filepath.Join(h.cfg.AppsDir, a.name)); err == nil {
			continue
		}
		doms := domainsByApp[a.id]
		if doms == nil {
			doms = []string{}
		}
		result.Orphaned = append(result.Orphaned, OrphanedApp{
			Name:      a.name,
			Port:      a.port,
			Domains:   doms,
			PM2Status: pm2Status[a.name],
		})
	}

	Success(w, result)
}
```

- [ ] **Step 4: Wire into `main.go`**

After `backupHandler := handlers.NewBackupHandler(db, exec, cfg)` add:

```go
	scanHandler := handlers.NewScanHandler(db, pm2, portAlloc, cfg)
```

Inside the compressed JSON group, directly under the `// Apps` block's last line (`r.Post("/apps/{name}/webhook", appsHandler.GenerateWebhook)`), add:

```go
			// Apps directory scan / import (static segments win over {name} in chi)
			r.Get("/apps/scan", scanHandler.Scan)
			r.Post("/apps/import", scanHandler.Import)
			r.Delete("/apps/scan/{name}", scanHandler.DeleteDir)
```

`Import` and `DeleteDir` do not exist yet; add temporary stubs at the end of `scan.go` so the build passes (they are replaced in Tasks 6 and 7):

```go
// Import handles POST /api/apps/import (implemented in Task 6)
func (h *ScanHandler) Import(w http.ResponseWriter, r *http.Request) {
	Error(w, http.StatusNotImplemented, "not implemented")
}

// DeleteDir handles DELETE /api/apps/scan/{name} (implemented in Task 7)
func (h *ScanHandler) DeleteDir(w http.ResponseWriter, r *http.Request) {
	Error(w, http.StatusNotImplemented, "not implemented")
}
```

- [ ] **Step 5: Build, vet, run the new tests**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run 'TestScanRouteNotShadowed|TestScanResultJSONShape' -v
```
Expected: silent build/vet; both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handlers/scan.go backend/internal/handlers/scan_test.go backend/main.go
git commit -m "feat(scan): add GET /api/apps/scan listing unmanaged dirs and orphaned records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: `ScanHandler.Import`

**Files:**
- Modify: `backend/internal/handlers/scan.go`
- Modify: `backend/internal/handlers/scan_test.go`

**Interfaces:**
- Produces:
  - `func (h *ScanHandler) Import(w, r)` — `POST /api/apps/import`, 201 with `importResponse{*models.App; Warning string}`.
  - `func resolveImportType(dir, appType, rootDir string) (string, string, error)` — pure: returns `(app_type, root_dir, err)`; runs `services.DetectAppType` only when `appType == ""`.
  - `func writePanelMeta(dir, appType, rootDir string) error`.
- Consumes: `appColumns`, `scanAppRow`, `validateOutputDir`, `parseEnvFile`, `choosePort`, `detectPort`, `readGitInfo`, `h.port.UsedPorts`, `h.pm2StatusMap`.

- [ ] **Step 1: Append failing tests for the pure pieces**

```go
func TestResolveImportType(t *testing.T) {
	t.Run("explicit type and root skip detection", func(t *testing.T) {
		dir := t.TempDir() // no package.json at all
		typ, root, err := resolveImportType(dir, "node", "/api")
		if err != nil || typ != "node" || root != "/api" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("explicit type defaults root", func(t *testing.T) {
		typ, root, err := resolveImportType(t.TempDir(), "static", "")
		if err != nil || typ != "static" || root != "/" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("invalid type rejected", func(t *testing.T) {
		if _, _, err := resolveImportType(t.TempDir(), "php", ""); err == nil {
			t.Error("expected error")
		}
	})
	t.Run("auto detects vite", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "vite.config.ts"), "export default {}")
		writeFile(t, filepath.Join(dir, "package.json"), `{"devDependencies":{"vite":"^5"}}`)
		typ, root, err := resolveImportType(dir, "", "")
		if err != nil || typ != "vite" || root != "/" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("auto with root hint detects in subdir", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "web", "next.config.js"), "module.exports={}")
		typ, root, err := resolveImportType(dir, "", "/web")
		if err != nil || typ != "next" || root != "/web" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("auto ambiguous surfaces detection error", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "web", "package.json"), `{"scripts":{"build":"x"},"dependencies":{"next":"1"}}`)
		writeFile(t, filepath.Join(dir, "app", "package.json"), `{"scripts":{"build":"x"},"dependencies":{"next":"1"}}`)
		if _, _, err := resolveImportType(dir, "", ""); err == nil {
			t.Error("expected ambiguity error")
		}
	})
}

func TestWritePanelMeta(t *testing.T) {
	dir := t.TempDir()
	if err := writePanelMeta(dir, "vite", "/web"); err != nil {
		t.Fatal(err)
	}
	meta, err := services.ReadPanelMeta(dir)
	if err != nil || meta.AppType != "vite" || meta.RootDir != "/web" {
		t.Errorf("got %+v %v", meta, err)
	}
}
```
(add `"panel-backend/internal/services"` to the test imports.)

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run 'TestResolveImportType|TestWritePanelMeta' -v
```
Expected: compile error `undefined: resolveImportType`.

- [ ] **Step 3: Replace the `Import` stub in `scan.go`**

Add `"encoding/json"` and `"panel-backend/internal/models"` to the imports. Remove the stub `Import` and add:

```go
var validImportTypes = map[string]bool{"next": true, "vite": true, "static": true, "node": true, "custom": true}

// resolveImportType returns the app type and root dir to record for an import.
// When appType is empty ("auto"), detection runs (scoped to rootDir when given).
func resolveImportType(dir, appType, rootDir string) (string, string, error) {
	if appType != "" {
		if !validImportTypes[appType] {
			return "", "", fmt.Errorf("app_type must be one of next, vite, static, node, custom")
		}
		if rootDir == "" {
			rootDir = "/"
		}
		return appType, rootDir, nil
	}
	hint := rootDir
	if hint == "" {
		hint = "/"
	}
	meta, err := services.DetectAppType(dir, hint)
	if err != nil {
		return "", "", err
	}
	return meta.AppType, meta.RootDir, nil
}

// writePanelMeta records the resolved type so syncPanelMeta agrees with the DB.
func writePanelMeta(dir, appType, rootDir string) error {
	data, err := json.Marshal(services.PanelMeta{AppType: appType, RootDir: rootDir})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ".panel_meta"), append(data, '\n'), 0644)
}

// importResponse is an App plus an optional warning about a PM2 port mismatch.
type importResponse struct {
	*models.App
	Warning string `json:"warning,omitempty"`
}

// Import handles POST /api/apps/import — registers an existing directory as an
// app without running any script or touching PM2/NGINX.
func (h *ScanHandler) Import(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string `json:"name"`
		AppType   string `json:"app_type"`
		RootDir   string `json:"root_dir"`
		OutputDir string `json:"output_dir"`
		Port      int    `json:"port"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if body.AppType == "auto" {
		body.AppType = ""
	}
	if !services.ValidateAppName(body.Name) {
		Error(w, http.StatusBadRequest, "Invalid app name. Use lowercase letters, numbers and hyphens only.")
		return
	}

	dir := filepath.Join(h.cfg.AppsDir, body.Name)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		Error(w, http.StatusNotFound, "Directory not found: "+dir)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var exists bool
	if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM apps WHERE name = $1)", body.Name).Scan(&exists); err != nil {
		Error(w, http.StatusInternalServerError, "Database error")
		return
	}
	if exists {
		Error(w, http.StatusConflict, "App is already managed by the panel")
		return
	}

	if body.RootDir != "" && (!strings.HasPrefix(body.RootDir, "/") || strings.Contains(body.RootDir, "..")) {
		Error(w, http.StatusBadRequest, "root_dir must start with / and must not contain ..")
		return
	}
	if body.OutputDir == "" {
		body.OutputDir = "dist"
	}
	if err := validateOutputDir(body.OutputDir); err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return
	}

	appType, rootDir, err := resolveImportType(dir, body.AppType, body.RootDir)
	if err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return
	}

	used, err := h.port.UsedPorts(ctx)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to read used ports")
		return
	}
	detectedPort := detectPort(dir)
	port, err := choosePort(body.Port, detectedPort, used, h.cfg.PortStart, h.cfg.PortEnd)
	if err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return
	}

	// Env vars: .env then .env.local overrides (same rule as ReadEnvFiles)
	envVars := make(map[string]string)
	for _, f := range []string{".env", ".env.local"} {
		if parsed, err := parseEnvFile(filepath.Join(dir, f)); err == nil {
			for k, v := range parsed {
				envVars[k] = v
			}
		}
	}

	repoURL, branch := "", ""
	if git := readGitInfo(dir); git != nil {
		repoURL, branch = git.RepoURL, git.Branch
	}
	if branch == "" && repoURL != "" {
		branch = "main"
	}

	if err := writePanelMeta(dir, appType, rootDir); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to write .panel_meta: "+err.Error())
		return
	}

	envJSON, _ := json.Marshal(envVars)
	app, err := scanAppRow(h.db.QueryRow(ctx,
		`INSERT INTO apps (name, repo_url, branch, port, env_vars, app_type, root_dir, output_dir)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING `+appColumns,
		body.Name, repoURL, branch, port, envJSON, appType, rootDir, body.OutputDir,
	))
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to save app")
		return
	}

	resp := importResponse{App: app}
	if status, ok := h.pm2StatusMap()[body.Name]; ok && detectedPort != 0 && detectedPort != port {
		resp.Warning = fmt.Sprintf("PM2 process (%s) is listening on %d but the app was registered on %d; run Setup to align them.", status, detectedPort, port)
	}
	SuccessCreated(w, resp)
}
```

- [ ] **Step 4: Run tests, build, vet**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run 'TestResolveImportType|TestWritePanelMeta' -v
```
Expected: silent build/vet; all subtests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/scan.go backend/internal/handlers/scan_test.go
git commit -m "feat(scan): add POST /api/apps/import to adopt an existing directory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: `ScanHandler.DeleteDir`

**Files:**
- Modify: `backend/internal/handlers/scan.go`
- Modify: `backend/internal/handlers/scan_test.go`

**Interfaces:**
- Produces:
  - `func resolveUnderAppsDir(appsDir, name string) (string, error)` — absolute path of `appsDir/name`, error if it escapes `appsDir` (uses `appsDir + separator` prefix, so sibling-prefix names cannot match).
  - `func (h *ScanHandler) DeleteDir(w, r)` — `DELETE /api/apps/scan/{name}`.

- [ ] **Step 1: Append failing test**

```go
func TestResolveUnderAppsDir(t *testing.T) {
	appsDir := t.TempDir()
	good, err := resolveUnderAppsDir(appsDir, "myapp")
	if err != nil || good != filepath.Join(appsDir, "myapp") {
		t.Errorf("got %q %v", good, err)
	}
	for _, bad := range []string{"..", "../x", "", "."} {
		if _, err := resolveUnderAppsDir(appsDir, bad); err == nil {
			t.Errorf("name %q should be rejected", bad)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && go test ./internal/handlers/ -run TestResolveUnderAppsDir -v
```
Expected: compile error `undefined: resolveUnderAppsDir`.

- [ ] **Step 3: Replace the `DeleteDir` stub in `scan.go`**

```go
// resolveUnderAppsDir returns the absolute path of appsDir/name and refuses
// anything that is not strictly inside appsDir.
func resolveUnderAppsDir(appsDir, name string) (string, error) {
	base, err := filepath.Abs(appsDir)
	if err != nil {
		return "", err
	}
	target, err := filepath.Abs(filepath.Join(base, name))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(target, base+string(filepath.Separator)) || target == base {
		return "", fmt.Errorf("path escapes apps directory")
	}
	return target, nil
}

// DeleteDir handles DELETE /api/apps/scan/{name} — removes an UNMANAGED directory.
func (h *ScanHandler) DeleteDir(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !services.ValidateAppName(name) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var managed bool
	if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM apps WHERE name = $1)", name).Scan(&managed); err != nil {
		Error(w, http.StatusInternalServerError, "Database error")
		return
	}
	if managed {
		Error(w, http.StatusConflict, "This app is managed by the panel; use the app's Delete action")
		return
	}

	target, err := resolveUnderAppsDir(h.cfg.AppsDir, name)
	if err != nil {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}
	if _, err := os.Stat(target); err != nil {
		Error(w, http.StatusNotFound, "Directory not found")
		return
	}

	h.pm2.Action("delete", name) // best effort — a stray process with this name

	if err := os.RemoveAll(target); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to remove directory: "+err.Error())
		return
	}
	Success(w, map[string]string{"message": "Directory removed"})
}
```
Add `"github.com/go-chi/chi/v5"` to the `scan.go` imports.

- [ ] **Step 4: Run all scan tests, build, vet**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run 'TestResolveUnderAppsDir|TestListUnmanagedDirs|TestDirSize|TestReadGitInfo|TestParseEcosystemPort|TestDetectPort|TestFindDomainsFor|TestChoosePort|TestScanRouteNotShadowed|TestScanResultJSONShape|TestResolveImportType|TestWritePanelMeta|TestValidateOutputDir' -v 2>&1 | grep -E '^(--- |ok|FAIL|PASS)'
```
Expected: every line `--- PASS`, final `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handlers/scan.go backend/internal/handlers/scan_test.go
git commit -m "feat(scan): add DELETE /api/apps/scan/{name} for unmanaged directories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Frontend types and `ScanModal` component

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/components/ScanModal.tsx`

**Interfaces:**
- Produces:
  - Types `DetectedType`, `UnmanagedDir`, `OrphanedApp`, `ScanResult` in `api.ts`.
  - `export default function ScanModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void })` — `onChanged` is called after any import/delete/remove so the Apps page can refresh its list.
- Consumes: `api.get/post/delete`, `Modal`, `StatusBadge`.

- [ ] **Step 1: Add types to `api.ts`** (append at the end of the file)

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

- [ ] **Step 2: Create `frontend/src/components/ScanModal.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { FolderSearch, GitBranch, Globe, Download, Trash2, AlertTriangle } from 'lucide-react';
import Modal from '@/components/Modal';
import StatusBadge from '@/components/StatusBadge';
import { api, App, ScanResult, UnmanagedDir, OrphanedApp } from '@/lib/api';

const APP_TYPE_OPTIONS = [
  { value: '',       label: 'Auto-detect' },
  { value: 'next',   label: 'Next.js' },
  { value: 'vite',   label: 'Vite / SPA' },
  { value: 'node',   label: 'Node.js' },
  { value: 'static', label: 'Static HTML' },
  { value: 'custom', label: 'Custom' },
];

function fmtSize(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const Spinner = () => <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />;

type Props = { onClose: () => void; onChanged: () => void };

export default function ScanModal({ onClose, onChanged }: Props) {
  const [scan, setScan]       = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [warning, setWarning] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const res = await api.get<ScanResult>('/apps/scan');
    if (res.success && res.data) setScan(res.data);
    else setError(res.error ?? 'Scan failed');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function changed(warn?: string) {
    if (warn) setWarning(warn);
    onChanged();
    load();
  }

  const empty = !!scan && scan.unmanaged.length === 0 && scan.orphaned.length === 0;

  return (
    <Modal title="Scan directory" description={scan ? scan.apps_dir : ''} onClose={onClose} size="lg">
      <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center"><Spinner /> Scanning…</div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
        )}
        {warning && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{warning}</span>
            <button onClick={() => setWarning('')} className="text-amber-500 hover:text-amber-300" aria-label="Dismiss">×</button>
          </div>
        )}
        {!loading && empty && (
          <div className="flex flex-col items-center py-10 text-center">
            <FolderSearch size={28} className="text-violet-500 mb-3" />
            <p className="text-gray-300 text-sm font-semibold">Everything in {scan?.apps_dir} is managed.</p>
          </div>
        )}

        {scan && scan.unmanaged.length > 0 && (
          <section>
            <p className="label mb-3">Unmanaged directories ({scan.unmanaged.length})</p>
            <div className="space-y-3">
              {scan.unmanaged.map((d) => (
                <UnmanagedRow key={d.name} dir={d} onChanged={changed} />
              ))}
            </div>
          </section>
        )}

        {scan && scan.orphaned.length > 0 && (
          <section>
            <p className="label mb-3">Orphaned records ({scan.orphaned.length})</p>
            <p className="text-xs text-gray-600 mb-3">These apps exist in the database but their directory is gone.</p>
            <div className="space-y-3">
              {scan.orphaned.map((o) => (
                <OrphanRow key={o.name} app={o} onChanged={() => changed()} />
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

// ── Unmanaged directory row ────────────────────────────────────────────────

function UnmanagedRow({ dir, onChanged }: { dir: UnmanagedDir; onChanged: (warn?: string) => void }) {
  const [mode, setMode] = useState<'idle' | 'import' | 'delete'>('idle');
  const requiresRoot = !!dir.detected.error;

  return (
    <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm font-mono">{dir.name}</span>
            {dir.detected.app_type && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-gray-400"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {dir.detected.app_type}{dir.detected.root_dir && dir.detected.root_dir !== '/' ? ` · ${dir.detected.root_dir}` : ''}
              </span>
            )}
            {dir.pm2 && <StatusBadge status={dir.pm2.status} />}
            {dir.pm2 && dir.pm2.port > 0 && <code className="text-[11px] text-gray-500 font-mono">:{dir.pm2.port}</code>}
            {!dir.pm2 && dir.detected_port > 0 && (
              <code className="text-[11px] text-gray-600 font-mono">port {dir.detected_port} (from disk)</code>
            )}
          </div>
          {dir.detected.error && (
            <p className="text-xs text-amber-400 mt-1">{dir.detected.error}</p>
          )}
          <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-600 flex-wrap">
            <span>{fmtSize(dir.size_bytes)}</span>
            {dir.modified_at && <span>modified {fmtDate(dir.modified_at)}</span>}
            {dir.git && dir.git.repo_url && (
              <span className="flex items-center gap-1 truncate max-w-[260px]" title={dir.git.repo_url}>
                <GitBranch size={10} /> {dir.git.repo_url}{dir.git.branch ? ` @ ${dir.git.branch}` : ''}
              </span>
            )}
            {dir.domains.map((dom) => (
              <span key={dom} className="flex items-center gap-1 text-blue-400"><Globe size={10} /> {dom}</span>
            ))}
            {dir.has_env && <span className="font-mono">.env</span>}
            {dir.has_ecosystem && <span className="font-mono">ecosystem.config.js</span>}
          </div>
          {!dir.valid_name && (
            <p className="text-xs text-amber-400 mt-1.5">Rename the folder to lowercase letters, numbers and hyphens to import it.</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {dir.valid_name && (
            <button onClick={() => setMode(mode === 'import' ? 'idle' : 'import')} className="btn-primary text-xs">
              <Download size={12} /> Import
            </button>
          )}
          <button onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')}
            className="p-2 rounded-xl text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all" title="Delete directory" aria-label="Delete directory">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {mode === 'import' && (
        <ImportForm dir={dir} requiresRoot={requiresRoot}
          onDone={(warn) => { setMode('idle'); onChanged(warn); }} onCancel={() => setMode('idle')} />
      )}
      {mode === 'delete' && (
        <TypedConfirm
          label={`Type ${dir.name} to delete this directory and any PM2 process with that name.`}
          expected={dir.name}
          buttonLabel="Delete directory"
          onConfirm={async () => {
            const res = await api.delete(`/apps/scan/${dir.name}`);
            if (!res.success) return res.error ?? 'Delete failed';
            setMode('idle'); onChanged(); return '';
          }}
          onCancel={() => setMode('idle')}
        />
      )}
    </div>
  );
}

// ── Import form (inline) ───────────────────────────────────────────────────

function ImportForm({ dir, requiresRoot, onDone, onCancel }:
  { dir: UnmanagedDir; requiresRoot: boolean; onDone: (warn?: string) => void; onCancel: () => void }) {
  const [appType, setAppType]     = useState(dir.detected.app_type);
  const [rootDir, setRootDir]     = useState(dir.detected.root_dir || '/');
  const [outputDir, setOutputDir] = useState('dist');
  const [port, setPort]           = useState(dir.pm2?.port || dir.detected_port || 0);
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState('');

  const canSubmit = !busy && (!requiresRoot || (rootDir && rootDir !== '/'));

  async function submit() {
    setBusy(true); setErr('');
    const res = await api.post<App & { warning?: string }>('/apps/import', {
      name: dir.name,
      app_type: appType,
      root_dir: rootDir || '/',
      output_dir: outputDir || 'dist',
      port: port || 0,
    });
    setBusy(false);
    if (res.success) onDone(res.data?.warning);
    else setErr(res.error ?? 'Import failed');
  }

  return (
    <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-3 animate-slide-up">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">App Type</label>
          <select className="input" value={appType} onChange={(e) => setAppType(e.target.value)}>
            {APP_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Port <span className="normal-case font-normal text-gray-700">(blank = next free)</span></label>
          <input className="input font-mono text-xs" type="number" min={0} value={port || ''}
            onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)} />
        </div>
        <div>
          <label className="label">Root Directory{requiresRoot && <span className="text-amber-400 ml-1">required</span>}</label>
          <input className="input font-mono text-xs" placeholder="/" value={rootDir}
            onChange={(e) => { let v = e.target.value; if (v && !v.startsWith('/')) v = '/' + v; setRootDir(v); }} />
        </div>
        <div>
          <label className="label">Output Directory</label>
          <input className="input font-mono text-xs" placeholder="dist" value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)} />
        </div>
      </div>
      <p className="text-[11px] text-gray-600">
        Will record: {dir.git?.repo_url ? <code className="text-gray-500">{dir.git.repo_url}</code> : 'no git repository'}
        {' · '}{dir.has_env ? 'env vars from .env' : 'no .env'}
        {' · '}nothing is rebuilt or restarted.
      </p>
      {err && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost text-xs" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary text-xs" onClick={submit} disabled={!canSubmit}>
          {busy ? <span className="flex items-center gap-2"><Spinner /> Importing…</span> : 'Import app'}
        </button>
      </div>
    </div>
  );
}

// ── Orphaned record row ────────────────────────────────────────────────────

function OrphanRow({ app, onChanged }: { app: OrphanedApp; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm font-mono">{app.name}</span>
            <code className="text-[11px] text-gray-500 font-mono">:{app.port}</code>
            {app.pm2_status && <StatusBadge status={app.pm2_status} />}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-600 flex-wrap">
            <span>directory missing</span>
            {app.domains.map((dom) => (
              <span key={dom} className="flex items-center gap-1 text-blue-400"><Globe size={10} /> {dom}</span>
            ))}
          </div>
        </div>
        <button onClick={() => setConfirming(!confirming)} className="btn-danger text-xs shrink-0">
          <Trash2 size={12} /> Remove record
        </button>
      </div>
      {confirming && (
        <TypedConfirm
          label={`Type ${app.name} to remove this record, its PM2 entry and its NGINX configs.`}
          expected={app.name}
          buttonLabel="Remove record"
          onConfirm={async () => {
            const res = await api.post(`/apps/${app.name}/action`, { action: 'delete' });
            if (!res.success) return res.error ?? 'Remove failed';
            setConfirming(false); onChanged(); return '';
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ── Typed-name confirmation block ──────────────────────────────────────────

function TypedConfirm({ label, expected, buttonLabel, onConfirm, onCancel }:
  { label: string; expected: string; buttonLabel: string; onConfirm: () => Promise<string>; onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  async function go() {
    setBusy(true); setErr('');
    const e = await onConfirm();
    setBusy(false);
    if (e) setErr(e);
  }

  return (
    <div className="mt-4 pt-4 border-t border-white/[0.06] space-y-2 animate-slide-up">
      <p className="text-xs text-red-400">{label}</p>
      <div className="flex gap-2">
        <input className="input font-mono text-xs flex-1" placeholder={expected} value={typed}
          onChange={(e) => setTyped(e.target.value)} autoFocus />
        <button className="btn-ghost text-xs" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-danger text-xs" onClick={go} disabled={busy || typed !== expected}>
          {busy ? <Spinner /> : buttonLabel}
        </button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx tsc -b
```
Expected: no output. If `FolderSearch` is not exported by lucide-react 0.400, replace it with `FolderOpen` (which is).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/ScanModal.tsx
git commit -m "feat(ui): add ScanModal for unmanaged directories and orphaned records

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: Apps page integration

**Files:**
- Modify: `frontend/src/pages/Apps.tsx`

**Interfaces:**
- Consumes: `ScanModal`, `ScanResult` from Task 8.

- [ ] **Step 1: Imports and state**

In `frontend/src/pages/Apps.tsx`:

Add `FolderSearch` to the lucide import list (use `FolderOpen` if Task 8 needed that swap) and add:

```ts
import ScanModal from '@/components/ScanModal';
import { api, App, ScanResult } from '@/lib/api';   // replaces the existing `import { api, App } from '@/lib/api';`
```

Inside `AppsPage`, after `const [error, setError] = useState('');` add:

```ts
  const [scan, setScan]         = useState<ScanResult | null>(null);
  const [showScan, setShowScan] = useState(false);

  const fetchScan = useCallback(async () => {
    const res = await api.get<ScanResult>('/apps/scan');
    if (res.success && res.data) setScan(res.data);
  }, []);
```

Change the existing effect from `useEffect(() => { fetchApps(); }, [fetchApps]);` to:

```ts
  useEffect(() => { fetchApps(); fetchScan(); }, [fetchApps, fetchScan]);
```

- [ ] **Step 2: Header button with badge**

Replace the header's single button:

```tsx
        <button onClick={() => setShowNew(true)} className="btn-primary">
          <Plus size={14} /> New App
        </button>
```

with:

```tsx
        <div className="flex items-center gap-2">
          <button onClick={() => setShowScan(true)} className="btn-ghost relative" title="Find directories in the apps folder that the panel does not manage">
            <FolderSearch size={14} /> Scan directory
            {scan && (scan.unmanaged.length + scan.orphaned.length) > 0 && (
              <span className="ml-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full text-amber-300"
                style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }}>
                {scan.unmanaged.length > 0 && `${scan.unmanaged.length} unmanaged`}
                {scan.unmanaged.length > 0 && scan.orphaned.length > 0 && ' · '}
                {scan.orphaned.length > 0 && `${scan.orphaned.length} orphaned`}
              </span>
            )}
          </button>
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <Plus size={14} /> New App
          </button>
        </div>
```

- [ ] **Step 3: Mount the modal**

Directly before the `{/* New App Modal */}` comment add:

```tsx
      {showScan && (
        <ScanModal
          onClose={() => { setShowScan(false); fetchScan(); }}
          onChanged={fetchApps}
        />
      )}
```

- [ ] **Step 4: Type-check and build**

```bash
cd frontend && npx tsc -b && npm run build 2>&1 | tail -5
```
Expected: `tsc` silent; build ends with `✓ built in …`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Apps.tsx
git commit -m "feat(ui): add Scan directory button and badge to Apps page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 10: End-to-end verification and docs

**Files:**
- Modify: `README.md` (API list)

This task exercises the DB-backed paths the unit tests cannot. It needs the local PostgreSQL (`backend/.env` already has a working `DATABASE_URL`; the backend has been run locally before).

- [ ] **Step 1: Build a fixture apps directory**

```bash
FIX="$TEMP/panel-apps-fixture"; rm -rf "$FIX"; mkdir -p "$FIX"
# 1. vite project with git + .env
mkdir -p "$FIX/my-site/.git" "$FIX/my-site/src"
printf 'ref: refs/heads/main\n' > "$FIX/my-site/.git/HEAD"
printf '[remote "origin"]\n\turl = https://github.com/acme/my-site.git\n' > "$FIX/my-site/.git/config"
printf '{"devDependencies":{"vite":"^5"}}' > "$FIX/my-site/package.json"
printf 'export default {}' > "$FIX/my-site/vite.config.ts"
printf 'API_URL=https://api.example.com\n' > "$FIX/my-site/.env"
# 2. node project with ecosystem.config.js on port 3004
mkdir -p "$FIX/api-server"
printf '{"scripts":{"start":"node index.js"},"dependencies":{"express":"4"}}' > "$FIX/api-server/package.json"
printf "module.exports={apps:[{name:'api-server',env:{PORT:'3004'}}]}" > "$FIX/api-server/ecosystem.config.js"
# 3. invalid name
mkdir -p "$FIX/Bad_Name"
# 4. dotdir and a file (must be ignored)
mkdir -p "$FIX/.cache"; echo x > "$FIX/notes.txt"
echo "$FIX"
```

- [ ] **Step 2: Start the backend against the fixture**

In a separate terminal (keep it running):

```bash
cd C:/Users/User/Documents/panel/backend && APPS_DIR="$TEMP/panel-apps-fixture" NGINX_AVAILABLE="$TEMP/panel-apps-fixture-nginx" PANEL_ENV=development go run .
```
Expected: `Panel backend listening on 127.0.0.1:4000`.

- [ ] **Step 3: Log in and call the scan endpoint**

```bash
cd C:/Users/User/Documents/panel
USER_=$(grep ^ADMIN_USERNAME backend/.env | cut -d= -f2); PASS_=$(grep ^ADMIN_PASSWORD backend/.env | cut -d= -f2)
curl -s -c "$TEMP/panel-cookie.txt" -H 'Content-Type: application/json' -d "{\"username\":\"$USER_\",\"password\":\"$PASS_\"}" http://127.0.0.1:4000/api/auth/login
curl -s -b "$TEMP/panel-cookie.txt" http://127.0.0.1:4000/api/apps/scan | python -m json.tool
```
Expected: `unmanaged` has exactly `Bad_Name` (`valid_name: false`), `api-server` (`detected.app_type: "node"`, `detected_port: 3004`, `has_ecosystem: true`, `pm2: null`), `my-site` (`detected.app_type: "vite"`, `git.repo_url` set, `branch: "main"`, `has_env: true`). `.cache` and `notes.txt` are absent. `orphaned` lists every app currently in your local DB whose directory is not in the fixture (expected for a dev DB) — note one of those names for Step 6.

- [ ] **Step 4: Import both valid directories**

```bash
curl -s -b "$TEMP/panel-cookie.txt" -H 'Content-Type: application/json' -d '{"name":"my-site"}' http://127.0.0.1:4000/api/apps/import | python -m json.tool
curl -s -b "$TEMP/panel-cookie.txt" -H 'Content-Type: application/json' -d '{"name":"api-server","port":3004}' http://127.0.0.1:4000/api/apps/import | python -m json.tool
cat "$TEMP/panel-apps-fixture/my-site/.panel_meta"
```
Expected: first → 201, `app_type: "vite"`, `repo_url` = the GitHub URL, `env_vars.API_URL` set, `port` = first free in range, `output_dir: "dist"`. Second → 201 with `port: 3004` (or 400 "already used" if your dev DB already has 3004 — then retry without `port`). `.panel_meta` is `{"app_type":"vite","root_dir":"/"}`.

- [ ] **Step 5: Verify the error paths**

```bash
C="-s -b $TEMP/panel-cookie.txt -H Content-Type:application/json"
curl $C -d '{"name":"my-site"}' http://127.0.0.1:4000/api/apps/import; echo            # 409 already managed
curl $C -d '{"name":"ghost"}' http://127.0.0.1:4000/api/apps/import; echo              # 404 directory not found
curl $C -d '{"name":"Bad_Name"}' http://127.0.0.1:4000/api/apps/import; echo           # 400 invalid name
curl $C -d '{"name":"my-site","output_dir":".."}' http://127.0.0.1:4000/api/apps/import; echo  # 409 (managed check runs first) — fine
curl $C -X DELETE http://127.0.0.1:4000/api/apps/scan/my-site; echo                    # 409 managed
curl $C -X DELETE http://127.0.0.1:4000/api/apps/scan/nope; echo                       # 404
curl -s -b "$TEMP/panel-cookie.txt" http://127.0.0.1:4000/api/apps/scan | python -c "import json,sys; d=json.load(sys.stdin)['data']; print([u['name'] for u in d['unmanaged']])"
```
Expected last line: `['Bad_Name']`.

- [ ] **Step 6: Orphan removal and directory delete**

```bash
# remove the two imported test apps via the existing delete action (also proves the orphan path: delete the dir first for one of them)
rm -rf "$TEMP/panel-apps-fixture/api-server"
curl -s -b "$TEMP/panel-cookie.txt" http://127.0.0.1:4000/api/apps/scan | python -c "import json,sys; d=json.load(sys.stdin)['data']; print([o['name'] for o in d['orphaned']])"
# expect api-server in the list
curl $C -d '{"action":"delete"}' http://127.0.0.1:4000/api/apps/api-server/action; echo   # 200
curl $C -d '{"action":"delete"}' http://127.0.0.1:4000/api/apps/my-site/action; echo      # 200 (removes the fixture dir too)
# directory delete of an unmanaged dir: recreate one and delete it through the scan endpoint
mkdir -p "$TEMP/panel-apps-fixture/leftover"
curl $C -X DELETE http://127.0.0.1:4000/api/apps/scan/leftover; echo                     # 200 Directory removed
ls "$TEMP/panel-apps-fixture"
```
Expected final listing: `Bad_Name  .cache  notes.txt` only (`.cache` hidden on some shells).

- [ ] **Step 7: UI check**

With the backend still running, in another terminal: `cd frontend && npm run dev`, open `http://localhost:3000/apps`.
- The "Scan directory" button shows a badge (at least "1 unmanaged" for `Bad_Name`, plus any orphans from your dev DB).
- Open it: `Bad_Name` row shows the rename hint and only a Delete icon; create `mkdir "$TEMP/panel-apps-fixture/demo-app"` and add a `package.json` with `{"scripts":{"start":"node i.js"}}`, reopen the modal: `demo-app` shows a `node` badge and Import.
- Import `demo-app` with the form: it disappears from the modal, appears in the Apps list, the badge count drops.
- Delete a directory via the typed-name confirm: the Delete button stays disabled until the exact name is typed.
- Remove an orphaned record: same typed confirm; it disappears and the list refreshes.
- Press Escape: modal closes and the badge re-fetches.

Stop the backend and dev server when done.

- [ ] **Step 8: Update README API list**

In `README.md`, in the `## API Endpoints` block, after the line `POST   /api/apps/{name}/deploy-zip …` add:

```
GET    /api/apps/scan                    List unmanaged directories in APPS_DIR and orphaned app records
POST   /api/apps/import                  Register an existing directory as an app (no build/restart)
DELETE /api/apps/scan/{name}             Delete an unmanaged directory
```

And in the Features table, in the `App Management` row, append `; scan /var/www/apps for unmanaged directories and import them` to the Details cell.

- [ ] **Step 9: Final checks and commit**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/handlers/ -run 'Scan|Import|Dir|Port|Git|Domains|OutputDir' 2>&1 | tail -3 && cd ../frontend && npx tsc -b && cd ..
git add README.md
git commit -m "docs: document apps scan/import endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git log --oneline main..HEAD
```
Expected: 10 commits on `feat/apps-scan-import`; tests `ok`; tsc silent.

---

## Self-review notes

- **Spec coverage:** scan response fields (Task 5), unmanaged rules incl. dotdir/symlink/valid_name (Task 2/5), detection error surfaced (Task 5/6), git from disk (Task 3), detected_port + pm2 (Task 3/5), domains by port/root (Task 4), orphaned with domains + pm2 status (Task 5), import steps 1–9 incl. warning (Task 6), output_dir validation shared with Create (Task 1), delete endpoint with 409/404/guard (Task 7), routes (Task 5), UI button/badge/modal/rows/inline import/typed confirm/orphans/empty state (Tasks 8–9), types (Task 8), README (Task 10). Out-of-scope items untouched.
- **Naming consistency:** `appColumns`, `scanAppRow`, `validateOutputDir` (Task 1) used in Task 6; `listUnmanagedDirs`, `dirSize` (Task 2), `readGitInfo`, `parseEcosystemPort`, `detectPort` (Task 3), `findDomainsFor`, `choosePort`, `UsedPorts` (Task 4) used in Tasks 5–6; `resolveImportType`, `writePanelMeta`, `importResponse` (Task 6); `resolveUnderAppsDir` (Task 7); TS types `ScanResult`, `UnmanagedDir`, `OrphanedApp`, `DetectedType` (Task 8) used in Task 9.
- **Windows:** all path code uses `filepath`; symlink test skips silently if `os.Symlink` fails; no test depends on `/proc`, PM2 or Postgres.
