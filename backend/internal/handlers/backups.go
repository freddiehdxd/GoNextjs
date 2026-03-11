package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"panel-backend/internal/config"
	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// BackupHandler handles backup settings and operations
type BackupHandler struct {
	db   *services.DB
	exec *services.Executor
	cfg  *config.Config

	mu       sync.RWMutex
	settings *models.BackupSettings
	running  bool
}

// NewBackupHandler creates a new backup handler and starts the scheduler
func NewBackupHandler(db *services.DB, exec *services.Executor, cfg *config.Config) *BackupHandler {
	h := &BackupHandler{db: db, exec: exec, cfg: cfg}
	h.loadSettings()
	go h.scheduleLoop()
	return h
}

func (h *BackupHandler) loadSettings() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var s models.BackupSettings
	err := h.db.QueryRow(ctx,
		`SELECT id, enabled, schedule, retain_days, backup_path,
		 s3_enabled, s3_endpoint, s3_bucket, s3_key, s3_secret, s3_region
		 FROM backup_settings LIMIT 1`,
	).Scan(&s.ID, &s.Enabled, &s.Schedule, &s.RetainDays, &s.BackupPath,
		&s.S3Enabled, &s.S3Endpoint, &s.S3Bucket, &s.S3Key, &s.S3Secret, &s.S3Region)
	if err != nil {
		return
	}

	h.mu.Lock()
	h.settings = &s
	h.mu.Unlock()
}

// GetSettings handles GET /api/backups/settings
func (h *BackupHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	s := h.settings
	h.mu.RUnlock()

	if s == nil {
		Success(w, &models.BackupSettings{
			Schedule:   "daily",
			RetainDays: 7,
			BackupPath: "/var/backups/panel",
		})
		return
	}

	// Redact S3 secret in response
	safe := *s
	if safe.S3Secret != "" {
		safe.S3Secret = "••••••••"
	}
	Success(w, safe)
}

// UpdateSettings handles PUT /api/backups/settings
func (h *BackupHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled    *bool   `json:"enabled"`
		Schedule   string  `json:"schedule"`
		RetainDays int     `json:"retain_days"`
		BackupPath string  `json:"backup_path"`
		S3Enabled  *bool   `json:"s3_enabled"`
		S3Endpoint string  `json:"s3_endpoint"`
		S3Bucket   string  `json:"s3_bucket"`
		S3Key      string  `json:"s3_key"`
		S3Secret   string  `json:"s3_secret"`
		S3Region   string  `json:"s3_region"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate schedule
	validSchedules := map[string]bool{"hourly": true, "daily": true, "weekly": true}
	if body.Schedule != "" && !validSchedules[body.Schedule] {
		Error(w, http.StatusBadRequest, "Schedule must be hourly, daily, or weekly")
		return
	}

	ctx := r.Context()

	// Build update dynamically to avoid overwriting S3 secret with placeholder
	h.mu.RLock()
	current := h.settings
	h.mu.RUnlock()

	s3Secret := ""
	if current != nil {
		s3Secret = current.S3Secret
	}
	if body.S3Secret != "" && body.S3Secret != "••••••••" {
		s3Secret = body.S3Secret
	}

	enabled := false
	if body.Enabled != nil {
		enabled = *body.Enabled
	} else if current != nil {
		enabled = current.Enabled
	}

	s3Enabled := false
	if body.S3Enabled != nil {
		s3Enabled = *body.S3Enabled
	} else if current != nil {
		s3Enabled = current.S3Enabled
	}

	schedule := "daily"
	if body.Schedule != "" {
		schedule = body.Schedule
	} else if current != nil {
		schedule = current.Schedule
	}

	retainDays := 7
	if body.RetainDays > 0 {
		retainDays = body.RetainDays
	} else if current != nil {
		retainDays = current.RetainDays
	}

	backupPath := "/var/backups/panel"
	if body.BackupPath != "" {
		backupPath = body.BackupPath
	} else if current != nil {
		backupPath = current.BackupPath
	}

	_, err := h.db.Exec(ctx,
		`UPDATE backup_settings SET
		 enabled = $1, schedule = $2, retain_days = $3, backup_path = $4,
		 s3_enabled = $5, s3_endpoint = $6, s3_bucket = $7, s3_key = $8, s3_secret = $9, s3_region = $10,
		 updated_at = NOW()`,
		enabled, schedule, retainDays, backupPath,
		s3Enabled, body.S3Endpoint, body.S3Bucket, body.S3Key, s3Secret, body.S3Region)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update settings")
		return
	}

	h.loadSettings()
	Success(w, map[string]string{"message": "Backup settings updated"})
}

// RunNow handles POST /api/backups/run
func (h *BackupHandler) RunNow(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	running := h.running
	h.mu.RUnlock()

	if running {
		Error(w, http.StatusConflict, "Backup already in progress")
		return
	}

	go h.performBackup()
	Success(w, map[string]string{"message": "Backup started"})
}

// History handles GET /api/backups/history
func (h *BackupHandler) History(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rows, err := h.db.Query(ctx,
		"SELECT id, type, filename, size_bytes, duration_ms, status, error, created_at FROM backup_history ORDER BY created_at DESC LIMIT 50")
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch history")
		return
	}
	defer rows.Close()

	entries := make([]models.BackupEntry, 0)
	for rows.Next() {
		var e models.BackupEntry
		if err := rows.Scan(&e.ID, &e.Type, &e.Filename, &e.SizeBytes, &e.DurationMs, &e.Status, &e.Error, &e.CreatedAt); err != nil {
			continue
		}
		entries = append(entries, e)
	}

	Success(w, entries)
}

// scheduleLoop runs backups on the configured schedule
func (h *BackupHandler) scheduleLoop() {
	time.Sleep(30 * time.Second) // initial delay

	for {
		h.mu.RLock()
		s := h.settings
		h.mu.RUnlock()

		if s == nil || !s.Enabled {
			time.Sleep(60 * time.Second)
			continue
		}

		// Calculate next run based on schedule
		var interval time.Duration
		switch s.Schedule {
		case "hourly":
			interval = 1 * time.Hour
		case "weekly":
			interval = 7 * 24 * time.Hour
		default: // daily
			interval = 24 * time.Hour
		}

		// Check if we should run (based on last backup time)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		var lastBackup time.Time
		h.db.QueryRow(ctx,
			"SELECT COALESCE(MAX(created_at), '2000-01-01') FROM backup_history WHERE status = 'completed'",
		).Scan(&lastBackup)
		cancel()

		if time.Since(lastBackup) >= interval {
			h.performBackup()
		}

		// Sleep for a while before checking again
		time.Sleep(5 * time.Minute)
	}
}

func (h *BackupHandler) performBackup() {
	h.mu.Lock()
	if h.running {
		h.mu.Unlock()
		return
	}
	h.running = true
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		h.running = false
		h.mu.Unlock()
	}()

	h.mu.RLock()
	s := h.settings
	h.mu.RUnlock()

	if s == nil {
		return
	}

	start := time.Now()
	backupPath := s.BackupPath
	if backupPath == "" {
		backupPath = "/var/backups/panel"
	}

	// Ensure backup directory exists
	os.MkdirAll(backupPath, 0750)

	timestamp := time.Now().Format("20060102-150405")
	filename := fmt.Sprintf("panel-backup-%s.tar.gz", timestamp)
	fullPath := filepath.Join(backupPath, filename)
	tmpDir := filepath.Join(backupPath, "tmp-"+timestamp)
	os.MkdirAll(tmpDir, 0750)
	defer os.RemoveAll(tmpDir)

	// 1. Dump all managed databases
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	rows, err := h.db.Query(ctx, "SELECT name FROM managed_databases")
	cancel()

	if err == nil {
		defer rows.Close()
		dbDir := filepath.Join(tmpDir, "databases")
		os.MkdirAll(dbDir, 0750)
		for rows.Next() {
			var dbName string
			rows.Scan(&dbName)
			dumpFile, err := os.Create(filepath.Join(dbDir, dbName+".sql"))
			if err != nil {
				continue
			}
			h.exec.RunBinStream(dumpFile, "pg_dump", "-h", "localhost", "-U", "postgres", "--no-owner", dbName)
			dumpFile.Close()
		}
	}

	// 2. Dump the panel's own database tables (apps, domains, settings)
	panelDump, err := os.Create(filepath.Join(tmpDir, "panel-schema.sql"))
	if err == nil {
		h.exec.RunBinStream(panelDump, "pg_dump", "-h", "localhost", "-U", "postgres",
			"--no-owner", "--table=apps", "--table=domains", "--table=managed_databases",
			"--table=alert_settings", "--table=backup_settings", "panel")
		panelDump.Close()
	}

	// 3. Create tar.gz of tmpDir + app .env files
	envDir := filepath.Join(tmpDir, "env-files")
	os.MkdirAll(envDir, 0750)

	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	appRows, err := h.db.Query(ctx2, "SELECT name FROM apps")
	cancel2()
	if err == nil {
		defer appRows.Close()
		for appRows.Next() {
			var appName string
			appRows.Scan(&appName)
			envPath := filepath.Join(h.cfg.AppsDir, appName, ".env")
			if data, err := os.ReadFile(envPath); err == nil {
				os.WriteFile(filepath.Join(envDir, appName+".env"), data, 0600)
			}
		}
	}

	// Create tar.gz
	result, execErr := h.exec.RunBin("tar", "-czf", fullPath, "-C", backupPath, "tmp-"+timestamp)
	if execErr != nil || (result != nil && result.Code != 0) {
		h.recordBackup("full", filename, 0, int(time.Since(start).Milliseconds()), "failed", "tar failed")
		return
	}

	// Get file size
	var size int64
	if fi, err := os.Stat(fullPath); err == nil {
		size = fi.Size()
	}

	// Record in history
	h.recordBackup("full", filename, size, int(time.Since(start).Milliseconds()), "completed", "")

	// Cleanup old backups
	h.cleanupOldBackups(backupPath, s.RetainDays)

	log.Printf("[backup] Completed: %s (%s)", filename, formatBytes(size))
}

func (h *BackupHandler) recordBackup(backupType, filename string, size int64, durationMs int, status, errMsg string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.db.Exec(ctx,
		"INSERT INTO backup_history (type, filename, size_bytes, duration_ms, status, error) VALUES ($1, $2, $3, $4, $5, $6)",
		backupType, filename, size, durationMs, status, errMsg)
}

func (h *BackupHandler) cleanupOldBackups(backupPath string, retainDays int) {
	entries, err := os.ReadDir(backupPath)
	if err != nil {
		return
	}

	cutoff := time.Now().AddDate(0, 0, -retainDays)
	type backupFile struct {
		name    string
		modTime time.Time
	}

	var backups []backupFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "panel-backup-") || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		backups = append(backups, backupFile{name: e.Name(), modTime: info.ModTime()})
	}

	// Sort oldest first
	sort.Slice(backups, func(i, j int) bool { return backups[i].modTime.Before(backups[j].modTime) })

	// Remove backups older than retention period, but always keep at least 1
	for i, b := range backups {
		if i >= len(backups)-1 {
			break // keep at least the most recent
		}
		if b.modTime.Before(cutoff) {
			os.Remove(filepath.Join(backupPath, b.name))
			log.Printf("[backup] Cleaned up old backup: %s", b.name)
		}
	}
}
