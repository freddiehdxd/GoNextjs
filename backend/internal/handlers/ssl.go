package handlers

import (
	"context"
	"log"
	"net/http"
	"time"

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
		Domain string `json:"domain"`
		Email  string `json:"email"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "domain and email required")
		return
	}

	if body.Domain == "" || body.Email == "" {
		Error(w, http.StatusBadRequest, "domain and email required")
		return
	}

	if !services.ValidateDomain(body.Domain) {
		Error(w, http.StatusBadRequest, "Invalid domain")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	// Look up domain and app port
	var port int
	err := h.db.QueryRow(ctx,
		`SELECT a.port FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = $1`,
		body.Domain,
	).Scan(&port)
	if err != nil {
		Error(w, http.StatusNotFound, "Domain not found")
		return
	}

	// Run certbot script
	result, err := h.exec.RunScript("create_ssl.sh", body.Domain, body.Email)
	if err != nil {
		Error(w, http.StatusInternalServerError, "SSL setup failed")
		return
	}
	if result.Code != 0 {
		log.Printf("SSL script failed for %s: %s", body.Domain, result.Stderr)
		Error(w, http.StatusInternalServerError, "SSL certificate issuance failed. Check that the domain points to this server.")
		return
	}

	// Rewrite NGINX config with SSL enabled
	if err := h.nginx.WriteConfig(body.Domain, port, true); err != nil {
		log.Printf("Failed to write NGINX SSL config for %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "Failed to configure NGINX for SSL")
		return
	}

	// Test and reload NGINX
	if err := h.nginx.TestAndReload(); err != nil {
		// Rollback to HTTP-only config
		h.nginx.WriteConfig(body.Domain, port, false)
		h.nginx.TestAndReload()
		log.Printf("NGINX reload failed after SSL enable for %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "NGINX configuration test failed, changes rolled back")
		return
	}

	// Update domains table
	_, err = h.db.Exec(ctx,
		"UPDATE domains SET ssl_enabled = true WHERE domain = $1",
		body.Domain)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update database")
		return
	}

	Success(w, map[string]string{"message": "SSL enabled for " + body.Domain})
}

// Disable handles POST /api/ssl/disable
func (h *SSLHandler) Disable(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Domain string `json:"domain"`
	}
	if err := ReadJSON(r, &body); err != nil || body.Domain == "" {
		Error(w, http.StatusBadRequest, "domain required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Look up domain and app port
	var port int
	err := h.db.QueryRow(ctx,
		`SELECT a.port FROM domains d JOIN apps a ON a.id = d.app_id WHERE d.domain = $1`,
		body.Domain,
	).Scan(&port)
	if err != nil {
		Error(w, http.StatusNotFound, "Domain not found")
		return
	}

	// Rewrite NGINX config without SSL (HTTP-only proxy)
	if err := h.nginx.WriteConfig(body.Domain, port, false); err != nil {
		log.Printf("Failed to write NGINX config for %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "Failed to update NGINX configuration")
		return
	}

	// Test and reload NGINX
	if err := h.nginx.TestAndReload(); err != nil {
		// Rollback to SSL config
		h.nginx.WriteConfig(body.Domain, port, true)
		h.nginx.TestAndReload()
		log.Printf("NGINX reload failed after SSL disable for %s: %v", body.Domain, err)
		Error(w, http.StatusInternalServerError, "NGINX configuration test failed, changes rolled back")
		return
	}

	// Update database
	_, err = h.db.Exec(ctx,
		"UPDATE domains SET ssl_enabled = false WHERE domain = $1",
		body.Domain)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update database")
		return
	}

	Success(w, map[string]string{"message": "SSL disabled for " + body.Domain})
}
