package handlers

import (
	"context"
	"log"
	"net/http"
	"time"

	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// SSLHandler handles SSL/TLS certificate routes
type SSLHandler struct {
	db    *services.DB
	nginx *services.Nginx
	exec  *services.Executor
}

// NewSSLHandler creates a new SSL handler
func NewSSLHandler(db *services.DB, nginx *services.Nginx, exec *services.Executor) *SSLHandler {
	return &SSLHandler{db: db, nginx: nginx, exec: exec}
}

// Enable handles POST /api/ssl
func (h *SSLHandler) Enable(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AppName string `json:"app_name"`
		Email   string `json:"email"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "app_name and email required")
		return
	}

	if body.AppName == "" || body.Email == "" {
		Error(w, http.StatusBadRequest, "app_name and email required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	// Get app
	var app models.App
	var envJSON interface{}
	err := h.db.QueryRow(ctx,
		"SELECT id, name, repo_url, branch, port, domain, ssl_enabled, env_vars, created_at, updated_at FROM apps WHERE name = $1",
		body.AppName,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&app.Domain, &app.SSLEnabled, &envJSON, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	if app.Domain == nil || *app.Domain == "" {
		Error(w, http.StatusBadRequest, "App has no domain assigned")
		return
	}

	domain := *app.Domain
	if !services.ValidateDomain(domain) {
		Error(w, http.StatusBadRequest, "Invalid domain")
		return
	}

	// Run certbot script
	result, err := h.exec.RunScript("create_ssl.sh", domain, body.Email)
	if err != nil {
		Error(w, http.StatusInternalServerError, "SSL setup failed")
		return
	}
	if result.Code != 0 {
		log.Printf("SSL script failed for %s: %s", domain, result.Stderr)
		Error(w, http.StatusInternalServerError, "SSL certificate issuance failed. Check that the domain points to this server.")
		return
	}

	// Rewrite NGINX config with SSL enabled
	if err := h.nginx.WriteConfig(domain, app.Port, true); err != nil {
		log.Printf("Failed to write NGINX SSL config for %s: %v", domain, err)
		Error(w, http.StatusInternalServerError, "Failed to configure NGINX for SSL")
		return
	}

	// Test and reload NGINX
	if err := h.nginx.TestAndReload(); err != nil {
		// Rollback to HTTP-only config
		h.nginx.WriteConfig(domain, app.Port, false)
		h.nginx.TestAndReload()
		log.Printf("NGINX reload failed after SSL enable for %s: %v", domain, err)
		Error(w, http.StatusInternalServerError, "NGINX configuration test failed, changes rolled back")
		return
	}

	// Update database
	_, err = h.db.Exec(ctx,
		"UPDATE apps SET ssl_enabled = true, updated_at = NOW() WHERE name = $1",
		body.AppName)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update database")
		return
	}

	Success(w, map[string]string{"message": "SSL enabled for " + domain})
}

// Disable handles POST /api/ssl/disable
func (h *SSLHandler) Disable(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AppName string `json:"app_name"`
	}
	if err := ReadJSON(r, &body); err != nil || body.AppName == "" {
		Error(w, http.StatusBadRequest, "app_name required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Get app
	var app models.App
	var envJSON interface{}
	err := h.db.QueryRow(ctx,
		"SELECT id, name, repo_url, branch, port, domain, ssl_enabled, env_vars, created_at, updated_at FROM apps WHERE name = $1",
		body.AppName,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&app.Domain, &app.SSLEnabled, &envJSON, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	if app.Domain == nil || *app.Domain == "" {
		Error(w, http.StatusBadRequest, "App has no domain assigned")
		return
	}

	domain := *app.Domain

	// Rewrite NGINX config without SSL (HTTP-only proxy)
	if err := h.nginx.WriteConfig(domain, app.Port, false); err != nil {
		log.Printf("Failed to write NGINX config for %s: %v", domain, err)
		Error(w, http.StatusInternalServerError, "Failed to update NGINX configuration")
		return
	}

	// Test and reload NGINX
	if err := h.nginx.TestAndReload(); err != nil {
		// Rollback to SSL config
		h.nginx.WriteConfig(domain, app.Port, true)
		h.nginx.TestAndReload()
		log.Printf("NGINX reload failed after SSL disable for %s: %v", domain, err)
		Error(w, http.StatusInternalServerError, "NGINX configuration test failed, changes rolled back")
		return
	}

	// Update database
	_, err = h.db.Exec(ctx,
		"UPDATE apps SET ssl_enabled = false, updated_at = NOW() WHERE name = $1",
		body.AppName)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update database")
		return
	}

	Success(w, map[string]string{"message": "SSL disabled for " + domain})
}
