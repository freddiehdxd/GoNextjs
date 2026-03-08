package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// DomainsHandler handles domain management routes
type DomainsHandler struct {
	db    *services.DB
	nginx *services.Nginx
}

// NewDomainsHandler creates a new domains handler
func NewDomainsHandler(db *services.DB, nginx *services.Nginx) *DomainsHandler {
	return &DomainsHandler{db: db, nginx: nginx}
}

// Add handles POST /api/domains
func (h *DomainsHandler) Add(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AppName string `json:"app_name"`
		Domain  string `json:"domain"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "app_name and domain required")
		return
	}

	if body.AppName == "" || body.Domain == "" {
		Error(w, http.StatusBadRequest, "app_name and domain required")
		return
	}

	if !services.ValidateDomain(body.Domain) {
		Error(w, http.StatusBadRequest, "Invalid domain name")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Get app
	var app models.App
	var envJSON []byte
	err := h.db.QueryRow(ctx,
		"SELECT id, name, repo_url, branch, port, domain, ssl_enabled, env_vars, created_at, updated_at FROM apps WHERE name = $1",
		body.AppName,
	).Scan(&app.ID, &app.Name, &app.RepoURL, &app.Branch, &app.Port,
		&app.Domain, &app.SSLEnabled, &envJSON, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}
	json.Unmarshal(envJSON, &app.EnvVars)

	// If app already has a domain, save old config for rollback
	var oldConfig string
	if app.Domain != nil && *app.Domain != "" {
		oldConfig, _ = h.nginx.ReadConfig(*app.Domain)
		h.nginx.RemoveConfig(*app.Domain)
	}

	// Write new HTTP-only config (ssl=false always when domain changes)
	if err := h.nginx.WriteConfig(body.Domain, app.Port, false); err != nil {
		// Rollback: restore old config
		if oldConfig != "" && app.Domain != nil {
			h.nginx.RestoreConfig(*app.Domain, oldConfig)
		}
		log.Printf("Failed to write NGINX config for %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "Failed to configure NGINX for domain")
		return
	}

	// Test and reload NGINX
	if err := h.nginx.TestAndReload(); err != nil {
		// Rollback: remove new config, restore old
		h.nginx.RemoveConfig(body.Domain)
		if oldConfig != "" && app.Domain != nil {
			h.nginx.RestoreConfig(*app.Domain, oldConfig)
			h.nginx.TestAndReload() // best effort reload with old config
		}
		log.Printf("NGINX reload failed for domain %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "NGINX configuration test failed, changes rolled back")
		return
	}

	// Update database
	var updatedApp models.App
	var updatedEnvJSON []byte
	err = h.db.QueryRow(ctx,
		`UPDATE apps SET domain = $1, ssl_enabled = false, updated_at = NOW() WHERE name = $2
		 RETURNING id, name, repo_url, branch, port, domain, ssl_enabled, env_vars, created_at, updated_at`,
		body.Domain, body.AppName,
	).Scan(&updatedApp.ID, &updatedApp.Name, &updatedApp.RepoURL, &updatedApp.Branch, &updatedApp.Port,
		&updatedApp.Domain, &updatedApp.SSLEnabled, &updatedEnvJSON, &updatedApp.CreatedAt, &updatedApp.UpdatedAt)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update app domain")
		return
	}
	json.Unmarshal(updatedEnvJSON, &updatedApp.EnvVars)

	Success(w, updatedApp)
}

// Remove handles DELETE /api/domains/:domain
func (h *DomainsHandler) Remove(w http.ResponseWriter, r *http.Request) {
	domain := chi.URLParam(r, "domain")

	if !services.ValidateDomain(domain) {
		Error(w, http.StatusBadRequest, "Invalid domain name")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// Remove NGINX config
	h.nginx.RemoveConfig(domain)

	// Reload NGINX (best effort)
	h.nginx.TestAndReload()

	// Update database: clear domain and ssl_enabled
	_, err := h.db.Exec(ctx,
		"UPDATE apps SET domain = NULL, ssl_enabled = false, updated_at = NOW() WHERE domain = $1",
		domain)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update database")
		return
	}

	Success(w, map[string]string{"message": "Domain " + domain + " removed"})
}
