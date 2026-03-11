package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/config"
	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

var (
	repoURLPattern = regexp.MustCompile(`^(https?://|git@)`)
	branchPattern  = regexp.MustCompile(`^[a-zA-Z0-9._/-]+$`)
)

// AppsHandler handles application routes
type AppsHandler struct {
	db    *services.DB
	pm2   *services.PM2
	exec  *services.Executor
	port  *services.PortAllocator
	nginx *services.Nginx
	cfg   *config.Config
}

// NewAppsHandler creates a new apps handler
func NewAppsHandler(db *services.DB, pm2 *services.PM2, exec *services.Executor, port *services.PortAllocator, nginx *services.Nginx, cfg *config.Config) *AppsHandler {
	return &AppsHandler{db: db, pm2: pm2, exec: exec, port: port, nginx: nginx, cfg: cfg}
}

// List handles GET /api/apps
func (h *AppsHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := h.db.Query(ctx,
		"SELECT id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, created_at, updated_at FROM apps ORDER BY created_at DESC")
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch apps")
		return
	}
	defer rows.Close()

	apps := make([]models.App, 0)
	for rows.Next() {
		var app models.App
		var envJSON []byte
		if err := rows.Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
			&envJSON, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts, &app.CreatedAt, &app.UpdatedAt); err != nil {
			Error(w, http.StatusInternalServerError, "Failed to scan app")
			return
		}
		if err := json.Unmarshal(envJSON, &app.EnvVars); err != nil {
			app.EnvVars = make(map[string]string)
		}
		app.Domains = make([]models.Domain, 0)
		apps = append(apps, app)
	}

	// Load all domains and attach to apps
	domainRows, err := h.db.Query(ctx,
		"SELECT id, app_id, domain, ssl_enabled, created_at FROM domains ORDER BY created_at")
	if err == nil {
		defer domainRows.Close()
		domainMap := make(map[string][]models.Domain)
		for domainRows.Next() {
			var d models.Domain
			if err := domainRows.Scan(&d.ID, &d.AppID, &d.Domain, &d.SSLEnabled, &d.CreatedAt); err == nil {
				domainMap[d.AppID] = append(domainMap[d.AppID], d)
			}
		}
		for i := range apps {
			if domains, ok := domainMap[apps[i].ID]; ok {
				apps[i].Domains = domains
			}
		}
	}

	// Enrich with PM2 status
	pm2List, err := h.pm2.List()
	if err == nil {
		pm2Map := make(map[string]models.Pm2Process)
		for _, p := range pm2List {
			pm2Map[p.Name] = p
		}
		for i := range apps {
			if proc, ok := pm2Map[apps[i].Name]; ok {
				apps[i].Status = proc.Status
				apps[i].CPU = proc.CPU
				apps[i].Memory = proc.Memory
			} else {
				apps[i].Status = "stopped"
			}
		}
	}

	Success(w, apps)
}

// Get handles GET /api/apps/:name
func (h *AppsHandler) Get(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	app, err := h.getAppByName(r.Context(), name)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	// Enrich with PM2 status
	pm2List, err := h.pm2.List()
	if err == nil {
		for _, p := range pm2List {
			if p.Name == app.Name {
				app.Status = p.Status
				app.CPU = p.CPU
				app.Memory = p.Memory
				break
			}
		}
	}
	if app.Status == "" {
		app.Status = "stopped"
	}

	Success(w, app)
}

// Create handles POST /api/apps
func (h *AppsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string            `json:"name"`
		RepoURL string            `json:"repo_url"`
		Branch  string            `json:"branch"`
		EnvVars map[string]string `json:"env_vars"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if body.Name == "" {
		Error(w, http.StatusBadRequest, "App name is required")
		return
	}

	if !services.ValidateAppName(body.Name) {
		Error(w, http.StatusBadRequest, "Invalid app name. Use lowercase letters, numbers and hyphens only.")
		return
	}

	if body.RepoURL != "" && !repoURLPattern.MatchString(body.RepoURL) {
		Error(w, http.StatusBadRequest, "Invalid repository URL. Must start with https:// or git@")
		return
	}

	if body.Branch == "" {
		body.Branch = "main"
	}
	if !branchPattern.MatchString(body.Branch) {
		Error(w, http.StatusBadRequest, "Invalid branch name. Use letters, numbers, dots, hyphens and slashes only.")
		return
	}

	if body.EnvVars == nil {
		body.EnvVars = make(map[string]string)
	}

	ctx := r.Context()

	// Check for duplicate
	var exists bool
	err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM apps WHERE name = $1)", body.Name).Scan(&exists)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Database error")
		return
	}
	if exists {
		Error(w, http.StatusConflict, "App name already exists")
		return
	}

	// Allocate port
	port, err := h.port.Allocate(ctx)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Deploy or create empty directory
	if body.RepoURL != "" {
		result, err := h.exec.RunScript("deploy_next_app.sh",
			body.Name, body.RepoURL, body.Branch, fmt.Sprintf("%d", port), "restart", "512")
		if err != nil {
			Error(w, http.StatusInternalServerError, "Deploy failed")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
	} else {
		appDir := h.cfg.AppsDir + "/" + body.Name
		if err := os.MkdirAll(appDir, 0755); err != nil {
			Error(w, http.StatusInternalServerError, "Failed to create app directory")
			return
		}
	}

	// Write .env file with user-defined env vars so deploy/setup scripts pick them up
	if len(body.EnvVars) > 0 {
		if err := h.writeEnvFile(body.Name, body.EnvVars); err != nil {
			// Non-fatal — log but continue
			fmt.Printf("[warn] failed to write .env for %s: %v\n", body.Name, err)
		}
	}

	// Insert into database
	envJSON, _ := json.Marshal(body.EnvVars)
	var app models.App
	var envBytes []byte
	err = h.db.QueryRow(ctx,
		`INSERT INTO apps (name, repo_url, branch, port, env_vars)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, created_at, updated_at`,
		body.Name, body.RepoURL, body.Branch, port, envJSON,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&envBytes, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to save app")
		return
	}
	json.Unmarshal(envBytes, &app.EnvVars)
	app.Domains = make([]models.Domain, 0)

	SuccessCreated(w, app)
}

// Action handles POST /api/apps/:name/action
func (h *AppsHandler) Action(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	var body struct {
		Action string `json:"action"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	ctx := r.Context()

	app, err := h.getAppByName(ctx, name)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	switch body.Action {
	case "start", "stop", "restart", "reload":
		result, err := h.pm2.Action(body.Action, app.Name)
		if err != nil {
			log.Printf("PM2 %s failed for %s: %v", body.Action, app.Name, err)
			Error(w, http.StatusInternalServerError, "Failed to "+body.Action+" app")
			return
		}
		Success(w, map[string]string{"message": result.Stdout})

	case "delete":
		// Delete from PM2 (best effort)
		h.pm2.Action("delete", app.Name)

		// Remove NGINX configs for all domains before DB delete
		for _, d := range app.Domains {
			h.nginx.RemoveConfig(d.Domain)
		}
		if len(app.Domains) > 0 {
			h.nginx.TestAndReload() // best effort reload
		}

		// Delete from DB (CASCADE removes domain rows)
		_, err := h.db.Exec(ctx, "DELETE FROM apps WHERE name = $1", app.Name)
		if err != nil {
			Error(w, http.StatusInternalServerError, "Failed to delete app")
			return
		}

		// Clean up filesystem
		appDir := filepath.Join(h.cfg.AppsDir, app.Name)
		if resolved, err := filepath.Abs(appDir); err == nil && strings.HasPrefix(resolved, filepath.Clean(h.cfg.AppsDir)) {
			os.RemoveAll(resolved)
		}

		Success(w, map[string]string{"message": "App deleted"})

	case "rebuild":
		if app.RepoURL == "" {
			Error(w, http.StatusBadRequest, "Cannot rebuild -- app has no git repository")
			return
		}

		// Write .env before rebuild so the script picks up current env vars
		h.writeEnvFile(app.Name, app.EnvVars)

		result, err := h.exec.RunScript("deploy_next_app.sh",
			app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
		if err != nil {
			Error(w, http.StatusInternalServerError, "Rebuild failed")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
		Success(w, map[string]string{"message": "Rebuild complete"})

	case "setup":
		// Write .env before setup so the script picks up current env vars
		h.writeEnvFile(app.Name, app.EnvVars)

		// Install dependencies, build, and start via PM2 (for manually uploaded apps)
		result, err := h.exec.RunScript("setup_app.sh",
			app.Name, fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
		if err != nil {
			log.Printf("Setup failed for %s: %v", app.Name, err)
			Error(w, http.StatusInternalServerError, "Setup failed")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
		Success(w, map[string]string{"message": "App deployed and running on port " + fmt.Sprintf("%d", app.Port)})

	case "setup-reload":
		// Write .env before setup so the script picks up current env vars
		h.writeEnvFile(app.Name, app.EnvVars)

		// Zero-downtime deploy: install, build, then PM2 reload (keeps old process serving until new one is ready)
		result, err := h.exec.RunScript("setup_app.sh",
			app.Name, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
		if err != nil {
			log.Printf("Setup-reload failed for %s: %v", app.Name, err)
			Error(w, http.StatusInternalServerError, "Zero-downtime deploy failed")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
		Success(w, map[string]string{"message": "Zero-downtime deploy complete on port " + fmt.Sprintf("%d", app.Port)})

	case "rebuild-reload":
		if app.RepoURL == "" {
			Error(w, http.StatusBadRequest, "Cannot rebuild -- app has no git repository")
			return
		}

		// Write .env before rebuild so the script picks up current env vars
		h.writeEnvFile(app.Name, app.EnvVars)

		// Zero-downtime rebuild: pull, install, build, then PM2 reload
		result, err := h.exec.RunScript("deploy_next_app.sh",
			app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
		if err != nil {
			Error(w, http.StatusInternalServerError, "Zero-downtime rebuild failed")
			return
		}
		if result.Code != 0 {
			Error(w, http.StatusInternalServerError, sanitizeDeployError(result.Stderr))
			return
		}
		Success(w, map[string]string{"message": "Zero-downtime rebuild complete"})

	default:
		Error(w, http.StatusBadRequest, "Invalid action")
	}
}

// UpdateEnv handles PUT /api/apps/:name/env
func (h *AppsHandler) UpdateEnv(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	var body struct {
		EnvVars map[string]string `json:"env_vars"`
	}
	if err := ReadJSON(r, &body); err != nil || body.EnvVars == nil {
		Error(w, http.StatusBadRequest, "env_vars object required")
		return
	}

	ctx := r.Context()

	// Check app exists
	_, err := h.getAppByName(ctx, name)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	envJSON, _ := json.Marshal(body.EnvVars)
	var app models.App
	var envBytes []byte
	err = h.db.QueryRow(ctx,
		`UPDATE apps SET env_vars = $1, updated_at = NOW() WHERE name = $2
		 RETURNING id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, created_at, updated_at`,
		envJSON, name,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&envBytes, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update env vars")
		return
	}
	json.Unmarshal(envBytes, &app.EnvVars)
	app.Domains = make([]models.Domain, 0)

	// Write .env file to app directory
	if err := h.writeEnvFile(name, body.EnvVars); err != nil {
		fmt.Printf("[warn] failed to write .env for %s: %v\n", name, err)
	}

	// Restart PM2 process with new env vars (best effort)
	// --update-env makes PM2 pick up the updated ecosystem env
	h.pm2.Action("restart", name)

	Success(w, app)
}

// UpdateSettings handles PUT /api/apps/:name/settings
func (h *AppsHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	var body struct {
		MaxMemory   *int `json:"max_memory"`
		MaxRestarts *int `json:"max_restarts"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	ctx := r.Context()
	app, err := h.getAppByName(ctx, name)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	if body.MaxMemory != nil {
		if *body.MaxMemory < 64 || *body.MaxMemory > 16384 {
			Error(w, http.StatusBadRequest, "max_memory must be between 64 and 16384 MB")
			return
		}
		app.MaxMemory = *body.MaxMemory
	}
	if body.MaxRestarts != nil {
		if *body.MaxRestarts < 0 || *body.MaxRestarts > 100 {
			Error(w, http.StatusBadRequest, "max_restarts must be between 0 and 100")
			return
		}
		app.MaxRestarts = *body.MaxRestarts
	}

	_, err = h.db.Exec(ctx,
		"UPDATE apps SET max_memory = $1, max_restarts = $2, updated_at = NOW() WHERE name = $3",
		app.MaxMemory, app.MaxRestarts, name)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update settings")
		return
	}

	Success(w, map[string]interface{}{
		"max_memory":   app.MaxMemory,
		"max_restarts": app.MaxRestarts,
	})
}

// GenerateWebhook handles POST /api/apps/:name/webhook — generates a webhook secret
func (h *AppsHandler) GenerateWebhook(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	ctx := r.Context()
	_, err := h.getAppByName(ctx, name)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	// Generate a random 32-char hex secret
	secret := generateSecret(32)

	_, err = h.db.Exec(ctx,
		"UPDATE apps SET webhook_secret = $1, updated_at = NOW() WHERE name = $2",
		secret, name)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to generate webhook")
		return
	}

	Success(w, map[string]string{
		"webhook_secret": secret,
		"webhook_url":    fmt.Sprintf("/api/webhook/%s", name),
	})
}

// Webhook handles POST /api/webhook/:name — unauthenticated, validates secret
func (h *AppsHandler) Webhook(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	ctx := r.Context()
	app, err := h.getAppByName(ctx, name)
	if err != nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}

	if app.WebhookSecret == "" {
		Error(w, http.StatusForbidden, "Webhook not configured")
		return
	}

	// Check secret from header or query param
	secret := r.Header.Get("X-Webhook-Secret")
	if secret == "" {
		secret = r.URL.Query().Get("secret")
	}
	if secret != app.WebhookSecret {
		Error(w, http.StatusUnauthorized, "Invalid secret")
		return
	}

	// Trigger rebuild or setup based on app type
	go func() {
		if app.RepoURL != "" {
			h.exec.RunScript("deploy_next_app.sh",
				app.Name, app.RepoURL, app.Branch, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
		} else {
			h.exec.RunScript("setup_app.sh",
				app.Name, fmt.Sprintf("%d", app.Port), "reload", fmt.Sprintf("%d", app.MaxMemory))
		}
	}()

	Success(w, map[string]string{"message": "Deploy triggered"})
}

// getAppByName fetches an app from the database by name
func (h *AppsHandler) getAppByName(ctx context.Context, name string) (*models.App, error) {
	var app models.App
	var envJSON []byte
	err := h.db.QueryRow(ctx,
		"SELECT id, name, repo_url, branch, port, env_vars, webhook_secret, max_memory, max_restarts, created_at, updated_at FROM apps WHERE name = $1",
		name,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&envJSON, &app.WebhookSecret, &app.MaxMemory, &app.MaxRestarts, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(envJSON, &app.EnvVars); err != nil {
		app.EnvVars = make(map[string]string)
	}

	// Load domains
	app.Domains = make([]models.Domain, 0)
	domainRows, err := h.db.Query(ctx,
		"SELECT id, app_id, domain, ssl_enabled, created_at FROM domains WHERE app_id = $1 ORDER BY created_at", app.ID)
	if err == nil {
		defer domainRows.Close()
		for domainRows.Next() {
			var d models.Domain
			if err := domainRows.Scan(&d.ID, &d.AppID, &d.Domain, &d.SSLEnabled, &d.CreatedAt); err == nil {
				app.Domains = append(app.Domains, d)
			}
		}
	}

	return &app, nil
}

// UploadProject handles POST /api/apps/:name/upload-project
// Accepts a zip file upload, extracts it into the app directory (replacing existing files)
func (h *AppsHandler) UploadProject(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidateAppName(name) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}

	ctx := r.Context()

	// Verify app exists
	_, err := h.getAppByName(ctx, name)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	// Parse multipart form (500MB max for project zips)
	if err := r.ParseMultipartForm(500 << 20); err != nil {
		Error(w, http.StatusBadRequest, "File too large or invalid upload (max 500MB)")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		Error(w, http.StatusBadRequest, "No file provided")
		return
	}
	defer file.Close()

	// Validate file extension
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".zip" {
		Error(w, http.StatusBadRequest, "Only .zip files are supported")
		return
	}

	appDir := filepath.Join(h.cfg.AppsDir, name)

	// Save uploaded zip to a temp file inside the app dir
	tmpFile, err := os.CreateTemp(appDir, "upload-*.zip")
	if err != nil {
		// App dir might not exist yet
		if err := os.MkdirAll(appDir, 0755); err != nil {
			Error(w, http.StatusInternalServerError, "Failed to create app directory")
			return
		}
		tmpFile, err = os.CreateTemp(appDir, "upload-*.zip")
		if err != nil {
			Error(w, http.StatusInternalServerError, "Failed to create temp file")
			return
		}
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath) // Clean up temp zip after extraction

	if _, err := io.Copy(tmpFile, file); err != nil {
		tmpFile.Close()
		Error(w, http.StatusInternalServerError, "Failed to save uploaded file")
		return
	}
	tmpFile.Close()

	// Extract zip into app directory using unzip -o (overwrite)
	result, err := h.exec.RunBin("unzip", "-o", tmpPath, "-d", appDir)
	if err != nil {
		Error(w, http.StatusInternalServerError, fmt.Sprintf("Extraction failed: %v", err))
		return
	}
	if result.Code != 0 {
		errMsg := result.Stderr
		if len(errMsg) > 300 {
			errMsg = errMsg[:300] + "..."
		}
		Error(w, http.StatusInternalServerError, fmt.Sprintf("Extraction failed: %s", errMsg))
		return
	}

	// Count extracted files from stdout (unzip lists files it extracts)
	extractedLines := strings.Split(strings.TrimSpace(result.Stdout), "\n")
	fileCount := 0
	for _, line := range extractedLines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "inflating:") || strings.HasPrefix(line, "extracting:") || strings.HasPrefix(line, "creating:") {
			fileCount++
		}
	}

	Success(w, map[string]interface{}{
		"message": fmt.Sprintf("Project uploaded and extracted to /var/www/apps/%s", name),
		"files":   fileCount,
	})
}

// ReadEnvFiles handles GET /api/apps/:name/env-file
// Reads .env and .env.local from the app directory and returns merged key-value pairs.
// .env.local values override .env values (same as Next.js convention).
func (h *AppsHandler) ReadEnvFiles(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidateAppName(name) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}

	appDir := filepath.Join(h.cfg.AppsDir, name)

	// Read .env first, then .env.local overrides
	vars := make(map[string]string)
	sources := make(map[string]string) // track which file each var came from

	for _, filename := range []string{".env", ".env.local"} {
		filePath := filepath.Join(appDir, filename)
		parsed, err := parseEnvFile(filePath)
		if err != nil {
			continue // file doesn't exist or unreadable — skip
		}
		for k, v := range parsed {
			vars[k] = v
			sources[k] = filename
		}
	}

	// Return as ordered array for stable UI display
	type envEntry struct {
		Key    string `json:"key"`
		Value  string `json:"value"`
		Source string `json:"source"` // ".env" or ".env.local"
	}
	entries := make([]envEntry, 0, len(vars))
	for k, v := range vars {
		entries = append(entries, envEntry{Key: k, Value: v, Source: sources[k]})
	}

	Success(w, map[string]interface{}{
		"vars":    vars,
		"entries": entries,
	})
}

// parseEnvFile reads a .env file and returns key-value pairs.
// Handles comments (#), empty lines, quoted values, and inline comments.
func parseEnvFile(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	vars := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Find the first = sign
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}

		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])

		// Strip surrounding quotes (double or single)
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}

		if key != "" {
			vars[key] = val
		}
	}

	return vars, nil
}

// writeEnvFile writes environment variables to /var/www/apps/{name}/.env
// This file is read by the deploy/setup scripts and injected into ecosystem.config.js
func (h *AppsHandler) writeEnvFile(appName string, envVars map[string]string) error {
	appDir := filepath.Join(h.cfg.AppsDir, appName)

	// Ensure app directory exists
	if err := os.MkdirAll(appDir, 0755); err != nil {
		return fmt.Errorf("create app dir: %w", err)
	}

	envPath := filepath.Join(appDir, ".env")

	if len(envVars) == 0 {
		// Remove .env if no vars (don't leave empty file)
		os.Remove(envPath)
		return nil
	}

	var lines []string
	for k, v := range envVars {
		// Escape values containing special chars by quoting
		if strings.ContainsAny(v, " \t\n\"'\\$#") {
			v = `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
		}
		lines = append(lines, fmt.Sprintf("%s=%s", k, v))
	}

	content := strings.Join(lines, "\n") + "\n"
	return os.WriteFile(envPath, []byte(content), 0600)
}

// sanitizeDeployError strips internal paths and limits error message length for client responses
func sanitizeDeployError(stderr string) string {
	if stderr == "" {
		return "Deploy script failed"
	}
	// Only return the last line (most relevant error) and truncate
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	msg := lines[len(lines)-1]
	// Strip common internal path prefixes
	for _, prefix := range []string{"/var/www/apps/", "/opt/panel/", "/home/", "/root/"} {
		msg = strings.ReplaceAll(msg, prefix, "")
	}
	if len(msg) > 200 {
		msg = msg[:200] + "..."
	}
	if msg == "" {
		return "Deploy script failed"
	}
	return msg
}

func generateSecret(length int) string {
	b := make([]byte, length/2)
	rand.Read(b)
	return hex.EncodeToString(b)
}
