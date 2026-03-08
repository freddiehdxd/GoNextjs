package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/config"
	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// DatabasesHandler handles managed database routes
type DatabasesHandler struct {
	db   *services.DB
	cfg  *config.Config
	exec *services.Executor
}

// NewDatabasesHandler creates a new databases handler
func NewDatabasesHandler(db *services.DB, cfg *config.Config, exec *services.Executor) *DatabasesHandler {
	return &DatabasesHandler{db: db, cfg: cfg, exec: exec}
}

// List handles GET /api/databases
func (h *DatabasesHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := h.db.Query(ctx,
		"SELECT id, name, db_user, created_at FROM managed_databases ORDER BY created_at DESC")
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch databases")
		return
	}
	defer rows.Close()

	type dbEntry struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		DBUser    string    `json:"db_user"`
		CreatedAt time.Time `json:"created_at"`
	}

	databases := make([]dbEntry, 0)
	for rows.Next() {
		var d dbEntry
		if err := rows.Scan(&d.ID, &d.Name, &d.DBUser, &d.CreatedAt); err != nil {
			Error(w, http.StatusInternalServerError, "Failed to scan database")
			return
		}
		databases = append(databases, d)
	}

	Success(w, databases)
}

// Create handles POST /api/databases
func (h *DatabasesHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		User string `json:"user"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "name and user required")
		return
	}

	if body.Name == "" || body.User == "" {
		Error(w, http.StatusBadRequest, "name and user required")
		return
	}

	if !services.ValidatePgIdentifier(body.Name) || !services.ValidatePgIdentifier(body.User) {
		Error(w, http.StatusBadRequest, "Invalid name or user. Use lowercase letters, numbers and underscores.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Check for duplicates
	var exists bool
	err := h.db.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM managed_databases WHERE name = $1 OR db_user = $2)",
		body.Name, body.User).Scan(&exists)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Database error")
		return
	}
	if exists {
		Error(w, http.StatusConflict, "Database or user already exists")
		return
	}

	// Generate password
	passwordBytes := make([]byte, 16)
	if _, err := rand.Read(passwordBytes); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to generate password")
		return
	}
	password := hex.EncodeToString(passwordBytes)

	// Create PostgreSQL user with the generated password
	// DDL statements (CREATE USER, ALTER ROLE) do not support parameterized passwords ($1),
	// so we use fmt.Sprintf. This is safe because:
	//   1. body.User is validated by ValidatePgIdentifier (alphanumeric + underscore only)
	//   2. password is hex-encoded random bytes (no special characters)
	_, err = h.db.Exec(ctx,
		fmt.Sprintf(`CREATE USER "%s" WITH PASSWORD '%s'`, body.User, password))
	if err != nil {
		log.Printf("Failed to create PostgreSQL user %s: %v", body.User, err)
		Error(w, http.StatusInternalServerError, "Failed to create database user")
		return
	}

	// Create database (must be outside a transaction in PostgreSQL)
	// We need to use a separate connection for this
	_, err = h.db.Exec(ctx,
		fmt.Sprintf(`CREATE DATABASE "%s" OWNER "%s"`, body.Name, body.User))
	if err != nil {
		// Rollback: drop user
		h.db.Exec(ctx, fmt.Sprintf(`DROP USER IF EXISTS "%s"`, body.User))
		log.Printf("Failed to create PostgreSQL database %s: %v", body.Name, err)
		Error(w, http.StatusInternalServerError, "Failed to create database")
		return
	}

	// Store in managed_databases
	_, err = h.db.Exec(ctx,
		"INSERT INTO managed_databases (name, db_user, password) VALUES ($1, $2, $3)",
		body.Name, body.User, password)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to save database record")
		return
	}

	connStr := fmt.Sprintf("postgresql://%s:%s@%s:5432/%s", body.User, password, h.cfg.DBHost, body.Name)

	SuccessCreated(w, map[string]string{
		"name":              body.Name,
		"db_user":           body.User,
		"connection_string": connStr,
	})
}

// Delete handles DELETE /api/databases/:name
func (h *DatabasesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidatePgIdentifier(name) {
		Error(w, http.StatusBadRequest, "Invalid database name")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Look up the database
	var dbUser string
	err := h.db.QueryRow(ctx,
		"SELECT db_user FROM managed_databases WHERE name = $1", name).Scan(&dbUser)
	if err != nil {
		Error(w, http.StatusNotFound, "Database not found")
		return
	}

	// Terminate active connections
	h.db.Exec(ctx,
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", name)

	// Drop database
	h.db.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS "%s"`, name))

	// Drop user (best effort)
	h.db.Exec(ctx, fmt.Sprintf(`DROP USER IF EXISTS "%s"`, dbUser))

	// Remove from managed_databases
	h.db.Exec(ctx, "DELETE FROM managed_databases WHERE name = $1", name)

	Success(w, map[string]string{"message": "Database " + name + " deleted"})
}

// Stats handles GET /api/databases/stats — PostgreSQL monitoring dashboard
func (h *DatabasesHandler) Stats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	overview := models.PgOverview{}

	// PostgreSQL version
	_ = h.db.QueryRow(ctx, "SELECT version()").Scan(&overview.Version)

	// Uptime
	var uptimeSecs float64
	_ = h.db.QueryRow(ctx, "SELECT EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))").Scan(&uptimeSecs)
	overview.Uptime = formatPgUptime(int(uptimeSecs))

	// max_connections setting
	var maxConnsStr string
	_ = h.db.QueryRow(ctx, "SHOW max_connections").Scan(&maxConnsStr)
	fmt.Sscanf(maxConnsStr, "%d", &overview.MaxConns)

	// Connection breakdown by state
	rows, err := h.db.Query(ctx, `
		SELECT COALESCE(state, 'unknown'), COUNT(*)
		FROM pg_stat_activity
		WHERE backend_type = 'client backend'
		GROUP BY state ORDER BY COUNT(*) DESC`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var ci models.PgConnInfo
			if rows.Scan(&ci.State, &ci.Count) == nil {
				overview.Connections = append(overview.Connections, ci)
				overview.TotalConns += ci.Count
				if ci.State == "active" {
					overview.ActiveConns = ci.Count
				} else if ci.State == "idle" {
					overview.IdleConns = ci.Count
				}
			}
		}
	}

	// Global cache hit ratio across all databases
	_ = h.db.QueryRow(ctx, `
		SELECT COALESCE(
			ROUND(SUM(blks_hit)::numeric / NULLIF(SUM(blks_hit) + SUM(blks_read), 0) * 100, 2),
		0) FROM pg_stat_database`).Scan(&overview.CacheHit)

	// Aggregate transaction + tuple stats
	_ = h.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(xact_commit),0), COALESCE(SUM(xact_rollback),0),
		       COALESCE(SUM(tup_fetched),0), COALESCE(SUM(tup_inserted),0),
		       COALESCE(SUM(tup_updated),0), COALESCE(SUM(tup_deleted),0),
		       COALESCE(SUM(conflicts),0), COALESCE(SUM(deadlocks),0),
		       COALESCE(SUM(temp_bytes),0)
		FROM pg_stat_database`).Scan(
		&overview.TxCommit, &overview.TxRollback,
		&overview.TupFetched, &overview.TupInserted,
		&overview.TupUpdated, &overview.TupDeleted,
		&overview.Conflicts, &overview.Deadlocks,
		&overview.TempBytes)

	// Per-database stats (only managed + panel db, skip template/postgres)
	dbRows, err := h.db.Query(ctx, `
		SELECT d.datname,
		       pg_database_size(d.datname),
		       s.numbackends,
		       s.xact_commit, s.xact_rollback,
		       COALESCE(ROUND(s.blks_hit::numeric / NULLIF(s.blks_hit + s.blks_read, 0) * 100, 2), 0),
		       s.tup_fetched, s.tup_inserted, s.tup_updated, s.tup_deleted
		FROM pg_database d
		JOIN pg_stat_database s ON s.datname = d.datname
		WHERE d.datistemplate = false AND d.datname != 'postgres'
		ORDER BY pg_database_size(d.datname) DESC`)
	if err == nil {
		defer dbRows.Close()
		for dbRows.Next() {
			var ds models.PgDbStats
			if dbRows.Scan(&ds.Name, &ds.Size, &ds.NumBackends,
				&ds.TxCommit, &ds.TxRollback, &ds.CacheHit,
				&ds.TupFetched, &ds.TupInserted, &ds.TupUpdated, &ds.TupDeleted) == nil {
				overview.DbStats = append(overview.DbStats, ds)
			}
		}
	}

	// Active/slow queries (running > 100ms, limited to 20)
	qRows, err := h.db.Query(ctx, `
		SELECT pid, COALESCE(datname,''), COALESCE(usename,''),
		       EXTRACT(epoch FROM (now() - query_start)),
		       COALESCE(state,''), LEFT(query, 200),
		       COALESCE(wait_event_type || ':' || wait_event, '')
		FROM pg_stat_activity
		WHERE state = 'active' AND pid != pg_backend_pid()
		  AND query NOT LIKE '%pg_stat%'
		  AND query_start < now() - interval '100 milliseconds'
		ORDER BY query_start ASC LIMIT 20`)
	if err == nil {
		defer qRows.Close()
		for qRows.Next() {
			var sq models.PgSlowQuery
			if qRows.Scan(&sq.PID, &sq.Database, &sq.User, &sq.Duration,
				&sq.State, &sq.Query, &sq.WaitEvent) == nil {
				sq.Duration = math.Round(sq.Duration*1000) / 1000
				overview.SlowQueries = append(overview.SlowQueries, sq)
			}
		}
	}

	// Ensure non-nil slices for JSON
	if overview.DbStats == nil {
		overview.DbStats = []models.PgDbStats{}
	}
	if overview.SlowQueries == nil {
		overview.SlowQueries = []models.PgSlowQuery{}
	}
	if overview.Connections == nil {
		overview.Connections = []models.PgConnInfo{}
	}

	Success(w, overview)
}

// Backup handles GET /api/databases/{name}/backup — downloads a pg_dump of the database
func (h *DatabasesHandler) Backup(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidatePgIdentifier(name) {
		Error(w, http.StatusBadRequest, "Invalid database name")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Verify the database exists in managed_databases and get credentials
	var dbUser, password string
	err := h.db.QueryRow(ctx,
		"SELECT db_user, password FROM managed_databases WHERE name = $1", name).Scan(&dbUser, &password)
	if err != nil {
		Error(w, http.StatusNotFound, "Database not found")
		return
	}

	// Build the connection URI for pg_dump
	connURI := fmt.Sprintf("postgresql://%s:%s@%s:5432/%s", dbUser, password, h.cfg.DBHost, name)

	// Set headers for file download
	filename := fmt.Sprintf("%s_%s.sql", name, time.Now().Format("20060102_150405"))
	w.Header().Set("Content-Type", "application/sql")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))

	// Stream pg_dump output directly to the response writer
	if err := h.exec.RunBinStream(w, "pg_dump", "--no-owner", "--no-acl", connURI); err != nil {
		log.Printf("Backup failed for database %s: %v", name, err)
		// If headers already sent we can't change status, but if nothing written yet we can error
		// In practice pg_dump either fails fast (bad connection) or streams data
		http.Error(w, "Backup failed", http.StatusInternalServerError)
		return
	}
}

// Restore handles POST /api/databases/{name}/restore — restores a SQL or custom-format dump
func (h *DatabasesHandler) Restore(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidatePgIdentifier(name) {
		Error(w, http.StatusBadRequest, "Invalid database name")
		return
	}

	// Parse multipart form (max 500 MB)
	if err := r.ParseMultipartForm(500 << 20); err != nil {
		Error(w, http.StatusBadRequest, "File too large or invalid upload")
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
	if ext != ".sql" && ext != ".dump" && ext != ".bak" && ext != ".backup" {
		Error(w, http.StatusBadRequest, "Only .sql, .dump, .bak, and .backup files are supported")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Verify the database exists in managed_databases and get credentials
	var dbUser, password string
	err = h.db.QueryRow(ctx,
		"SELECT db_user, password FROM managed_databases WHERE name = $1", name).Scan(&dbUser, &password)
	if err != nil {
		Error(w, http.StatusNotFound, "Database not found")
		return
	}

	connURI := fmt.Sprintf("postgresql://%s:%s@%s:5432/%s", dbUser, password, h.cfg.DBHost, name)

	// Detect dump format by reading the first 5 bytes.
	// PostgreSQL custom-format dumps start with magic bytes "PGDMP".
	// pg_restore requires a seekable file, so for custom-format we save to a temp file.
	header5 := make([]byte, 5)
	n, _ := io.ReadFull(file, header5)
	isCustomFormat := n == 5 && string(header5) == "PGDMP"

	var result *models.ExecResult

	if isCustomFormat {
		// pg_restore needs a file on disk (can't read from stdin for custom format reliably).
		// Save uploaded data to a temp file, then run pg_restore with the file path.
		tmpFile, err := os.CreateTemp("", "restore-*.dump")
		if err != nil {
			Error(w, http.StatusInternalServerError, "Failed to create temp file")
			return
		}
		tmpPath := tmpFile.Name()
		defer os.Remove(tmpPath)

		// Write the 5 header bytes we already read, then the rest
		tmpFile.Write(header5[:n])
		if _, err := io.Copy(tmpFile, file); err != nil {
			tmpFile.Close()
			Error(w, http.StatusInternalServerError, "Failed to save uploaded file")
			return
		}
		tmpFile.Close()

		// Run pg_restore:
		//   --clean --if-exists: drop existing objects before recreating (safe for re-imports)
		//   --no-owner --no-acl: skip ownership/permissions from the dump
		//   --dbname: target database connection URI
		result, err = h.exec.RunBin("pg_restore",
			"--clean", "--if-exists",
			"--no-owner", "--no-acl",
			"--dbname", connURI,
			tmpPath)
		if err != nil {
			log.Printf("pg_restore failed for database %s: %v", name, err)
			Error(w, http.StatusInternalServerError, "Restore failed")
			return
		}
	} else {
		// Plain SQL format — pipe into psql
		// Reconstruct the reader: the 5 bytes we peeked + the rest of the file
		reader := io.MultiReader(
			strings.NewReader(string(header5[:n])),
			file,
		)
		result, err = h.exec.RunBinWithStdin(reader, "psql", "-v", "ON_ERROR_STOP=1", connURI)
		if err != nil {
			log.Printf("psql restore failed for database %s: %v", name, err)
			Error(w, http.StatusInternalServerError, "Restore failed")
			return
		}
	}

	// Collect error details from both stderr and stdout
	errOutput := strings.TrimSpace(result.Stderr)
	if errOutput == "" {
		errOutput = strings.TrimSpace(result.Stdout)
	}

	if result.Code != 0 {
		errMsg := extractPsqlErrors(errOutput)
		if errMsg == "" {
			if isCustomFormat {
				errMsg = fmt.Sprintf("pg_restore exited with code %d. Check that the dump is compatible with this database.", result.Code)
			} else {
				errMsg = fmt.Sprintf("psql exited with code %d. Check that the SQL file is valid and compatible with this database.", result.Code)
			}
		}

		// pg_restore exit code 1 means "completed with warnings" (e.g. "already exists" errors).
		// Only truly fatal if the error output contains FATAL or connection-level errors.
		if isCustomFormat && result.Code == 1 && !containsFatalErrors(errOutput) {
			Success(w, map[string]string{
				"message":  "Database " + name + " restored with warnings",
				"warnings": errMsg,
			})
			return
		}

		Error(w, http.StatusInternalServerError, errMsg)
		return
	}

	// Even with exit code 0, check stderr for warnings (non-fatal)
	if errOutput != "" && containsPsqlErrors(errOutput) {
		warnMsg := extractPsqlErrors(errOutput)
		Success(w, map[string]string{
			"message":  "Database " + name + " restored with warnings",
			"warnings": warnMsg,
		})
		return
	}

	Success(w, map[string]string{"message": "Database " + name + " restored successfully"})
}

// extractPsqlErrors extracts meaningful error lines from psql output
func extractPsqlErrors(output string) string {
	if output == "" {
		return ""
	}

	lines := strings.Split(output, "\n")
	var errors []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Pick up ERROR, FATAL, and useful context lines
		lower := strings.ToLower(line)
		if strings.Contains(lower, "error") ||
			strings.Contains(lower, "fatal") ||
			strings.Contains(lower, "could not") ||
			strings.Contains(lower, "permission denied") ||
			strings.Contains(lower, "does not exist") ||
			strings.Contains(lower, "already exists") ||
			strings.Contains(lower, "syntax error") ||
			strings.Contains(lower, "no such file") ||
			strings.Contains(lower, "connection refused") ||
			strings.Contains(lower, "password authentication failed") {
			errors = append(errors, line)
		}
	}

	if len(errors) == 0 {
		// Return the last few lines as fallback
		start := len(lines) - 5
		if start < 0 {
			start = 0
		}
		return strings.Join(lines[start:], "\n")
	}

	// Limit to 10 error lines
	if len(errors) > 10 {
		errors = append(errors[:10], fmt.Sprintf("... and %d more errors", len(errors)-10))
	}
	return strings.Join(errors, "\n")
}

// containsPsqlErrors checks if output contains actual error indicators
func containsPsqlErrors(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "error") ||
		strings.Contains(lower, "fatal") ||
		strings.Contains(lower, "could not")
}

// containsFatalErrors checks if output contains truly fatal errors (not just warnings)
func containsFatalErrors(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "fatal") ||
		strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "password authentication failed") ||
		strings.Contains(lower, "no such file") ||
		strings.Contains(lower, "not a valid archive")
}

func formatPgUptime(totalSecs int) string {
	days := totalSecs / 86400
	hours := (totalSecs % 86400) / 3600
	mins := (totalSecs % 3600) / 60
	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, mins)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, mins)
	}
	return fmt.Sprintf("%dm", mins)
}
