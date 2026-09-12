package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"panel-backend/internal/config"
	"panel-backend/internal/models"
	"panel-backend/internal/services"
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

// findDomainsFor returns the names of NGINX site files in availDir that proxy
// to port (when port > 0) or serve a root at or under dirPath.
func findDomainsFor(availDir string, port int, dirPath string) []string {
	entries, err := os.ReadDir(availDir)
	if err != nil {
		return []string{}
	}
	proxyNeedle := ""
	upstreamNeedle := ""
	if port > 0 {
		proxyNeedle = fmt.Sprintf("proxy_pass http://127.0.0.1:%d;", port)
		upstreamNeedle = fmt.Sprintf("server 127.0.0.1:%d;", port)
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
		matched := false
		if upstreamNeedle != "" {
			for _, line := range strings.Split(content, "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "include ") {
					continue
				}
				includePath := strings.TrimSpace(strings.TrimPrefix(line, "include "))
				includePath = strings.TrimSuffix(includePath, ";")
				includePath = strings.Trim(includePath, "\"")
				if incData, err := os.ReadFile(includePath); err == nil && strings.Contains(string(incData), upstreamNeedle) {
					matches = append(matches, e.Name())
					matched = true
					break
				}
			}
		}
		if matched {
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
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	domains := make(map[string][]string)
	dRows, err := h.db.Query(ctx, "SELECT app_id, domain FROM domains ORDER BY domain")
	if err != nil {
		log.Printf("[scan] domains query failed: %v", err)
	} else {
		defer dRows.Close()
		for dRows.Next() {
			var appID, domain string
			if dRows.Scan(&appID, &domain) == nil {
				domains[appID] = append(domains[appID], domain)
			}
		}
		if err := dRows.Err(); err != nil {
			log.Printf("[scan] domains query failed: %v", err)
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
	info, err := os.Lstat(dir)
	if err != nil {
		Error(w, http.StatusNotFound, "Directory not found: "+dir)
		return
	}
	if info.Mode()&os.ModeSymlink != 0 {
		Error(w, http.StatusBadRequest, "symlinked directories cannot be imported")
		return
	}
	if !info.IsDir() {
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
		_ = os.Remove(filepath.Join(dir, ".panel_meta")) // best effort — avoid stranding meta the DB row doesn't back
		if isUniqueViolation(err) {
			Error(w, http.StatusConflict, "App name or port is already in use")
		} else {
			Error(w, http.StatusInternalServerError, "Failed to save app")
		}
		return
	}

	resp := importResponse{App: app}
	if status, ok := h.pm2StatusMap()[body.Name]; ok && detectedPort != 0 && detectedPort != port {
		resp.Warning = fmt.Sprintf("PM2 process (%s) is listening on %d but the app was registered on %d; run Setup to align them.", status, detectedPort, port)
	}
	SuccessCreated(w, resp)
}

// isUniqueViolation reports whether err is a Postgres unique_violation (23505),
// including when wrapped.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

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

// validateDirName accepts any single path segment that is safe to delete under
// AppsDir. Unlike ValidateAppName it allows uppercase/underscores so that
// directories the scan lists with valid_name:false can still be removed.
func validateDirName(name string) error {
	if name == "" || name == "." || name == ".." {
		return fmt.Errorf("invalid directory name")
	}
	if strings.ContainsAny(name, `/\`+"\x00") {
		return fmt.Errorf("directory name must not contain path separators")
	}
	return nil
}

// decodeDirName percent-decodes a route segment; the decoded value must still
// pass validateDirName. chi's URLParam returns the raw (still percent-encoded)
// path segment, so callers must decode before using the name.
func decodeDirName(raw string) (string, error) {
	name, err := url.PathUnescape(raw)
	if err != nil {
		return "", fmt.Errorf("invalid directory name encoding")
	}
	if err := validateDirName(name); err != nil {
		return "", err
	}
	return name, nil
}

// DeleteDir handles DELETE /api/apps/scan/{name} — removes an UNMANAGED directory.
func (h *ScanHandler) DeleteDir(w http.ResponseWriter, r *http.Request) {
	name, err := decodeDirName(chi.URLParam(r, "name"))
	if err != nil {
		Error(w, http.StatusBadRequest, err.Error())
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

	if _, ok := h.pm2StatusMap()[name]; ok {
		h.pm2.Action("delete", name) // best effort — a stray process with this exact name
	}

	if err := os.RemoveAll(target); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to remove directory: "+err.Error())
		return
	}
	Success(w, map[string]string{"message": "Directory removed"})
}
