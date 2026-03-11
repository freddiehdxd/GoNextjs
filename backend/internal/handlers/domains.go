package handlers

import (
	"context"
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
	var appID string
	var appPort int
	err := h.db.QueryRow(ctx,
		"SELECT id, port FROM apps WHERE name = $1", body.AppName,
	).Scan(&appID, &appPort)
	if err != nil {
		Error(w, http.StatusNotFound, "App not found")
		return
	}

	// Check if domain is already in use
	var exists bool
	err = h.db.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM domains WHERE domain = $1)", body.Domain,
	).Scan(&exists)
	if err == nil && exists {
		Error(w, http.StatusConflict, "Domain is already assigned to an app")
		return
	}

	// Write HTTP-only NGINX config
	if err := h.nginx.WriteConfig(body.Domain, appPort, false); err != nil {
		log.Printf("Failed to write NGINX config for %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "Failed to configure NGINX for domain")
		return
	}

	// Test and reload NGINX
	if err := h.nginx.TestAndReload(); err != nil {
		// Rollback: remove the new config
		h.nginx.RemoveConfig(body.Domain)
		log.Printf("NGINX reload failed for domain %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "NGINX configuration test failed, changes rolled back")
		return
	}

	// Insert into domains table
	var domain models.Domain
	err = h.db.QueryRow(ctx,
		`INSERT INTO domains (app_id, domain) VALUES ($1, $2)
		 RETURNING id, app_id, domain, ssl_enabled, created_at`,
		appID, body.Domain,
	).Scan(&domain.ID, &domain.AppID, &domain.Domain, &domain.SSLEnabled, &domain.CreatedAt)
	if err != nil {
		// Rollback NGINX config
		h.nginx.RemoveConfig(body.Domain)
		h.nginx.TestAndReload()
		Error(w, http.StatusInternalServerError, "Failed to save domain")
		return
	}

	Success(w, domain)
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

	// Delete from domains table
	_, err := h.db.Exec(ctx, "DELETE FROM domains WHERE domain = $1", domain)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update database")
		return
	}

	Success(w, map[string]string{"message": "Domain " + domain + " removed"})
}
