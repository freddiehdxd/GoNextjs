package services

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"panel-backend/internal/models"
)

// upstreamsDir is where per-domain upstream include files live. Each file
// contains a single `server 127.0.0.1:PORT;` line that the site's upstream
// block includes. Deploy scripts can rewrite it to support blue/green swaps
// without touching the panel-managed site config.
const upstreamsDir = "/etc/nginx/upstreams"

// upstreamName returns an nginx-safe upstream identifier for a domain.
func upstreamName(domain string) string {
	r := strings.NewReplacer(".", "_", "-", "_")
	return "app_" + r.Replace(domain)
}

// upstreamIncludePath returns the per-domain include file path.
func upstreamIncludePath(domain string) string {
	return filepath.Join(upstreamsDir, domain+".conf")
}

// ensureUpstreamInclude writes the default `server 127.0.0.1:PORT;` include
// file for a domain, but only if it doesn't already exist. Deploy scripts
// own the file after first creation.
func ensureUpstreamInclude(domain string, port int) error {
	if err := os.MkdirAll(upstreamsDir, 0755); err != nil {
		return fmt.Errorf("mkdir %s: %w", upstreamsDir, err)
	}
	path := upstreamIncludePath(domain)
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	content := fmt.Sprintf("server 127.0.0.1:%d;\n", port)
	return os.WriteFile(path, []byte(content), 0644)
}

// Nginx manages NGINX configuration files
type Nginx struct {
	exec       *Executor
	availDir   string
	enabledDir string
}

// NewNginx creates a new NGINX service
func NewNginx(exec *Executor, availDir, enabledDir string) *Nginx {
	return &Nginx{
		exec:       exec,
		availDir:   availDir,
		enabledDir: enabledDir,
	}
}

// BuildConfig generates an NGINX server block configuration.
//
// The generated config uses a named upstream whose single server entry is
// loaded from /etc/nginx/upstreams/<domain>.conf. The panel writes a default
// version of that include file (pointing at 127.0.0.1:<port>) on first
// generation; deploy scripts can later rewrite it to swap colors for
// blue/green deploys without touching the panel-managed site config.
func (n *Nginx) BuildConfig(domain string, port int, ssl bool) string {
	upstream := upstreamName(domain)
	include := upstreamIncludePath(domain)

	if ssl {
		return fmt.Sprintf(`# Managed by Panel -- do not edit manually
upstream %s {
    include %s;
}

server {
    listen 80;
    server_name %s;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name %s;

    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 100M;

    location / {
        proxy_pass http://%s;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
`, upstream, include, domain, domain, domain, domain, upstream)
	}

	return fmt.Sprintf(`# Managed by Panel -- do not edit manually
upstream %s {
    include %s;
}

server {
    listen 80;
    server_name %s;

    client_max_body_size 100M;

    location / {
        proxy_pass http://%s;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
`, upstream, include, domain, upstream)
}

// BuildStaticConfig generates an NGINX server block that serves static files from docRoot.
func (n *Nginx) BuildStaticConfig(domain, docRoot string, ssl bool) string {
	if ssl {
		return fmt.Sprintf(`# Managed by Panel -- do not edit manually
server {
    listen 80;
    server_name %s;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name %s;

    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 100M;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    root %s;
    index index.html;

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
`, domain, domain, domain, domain, docRoot)
	}

	return fmt.Sprintf(`# Managed by Panel -- do not edit manually
server {
    listen 80;
    server_name %s;

    client_max_body_size 100M;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    root %s;
    index index.html;

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
`, domain, docRoot)
}

// WriteStaticConfig writes a static-file NGINX config and creates the symlink.
func (n *Nginx) WriteStaticConfig(domain, docRoot string, ssl bool) error {
	config := n.BuildStaticConfig(domain, docRoot, ssl)

	availPath := filepath.Join(n.availDir, domain)
	enabledPath := filepath.Join(n.enabledDir, domain)

	if err := os.WriteFile(availPath, []byte(config), 0644); err != nil {
		return fmt.Errorf("write nginx static config: %w", err)
	}

	os.Remove(enabledPath)

	if err := os.Symlink(availPath, enabledPath); err != nil {
		return fmt.Errorf("create nginx symlink: %w", err)
	}

	return nil
}

// WriteConfig writes NGINX config and creates symlink
func (n *Nginx) WriteConfig(domain string, port int, ssl bool) error {
	// Write the upstream include file first so the new config validates on
	// nginx -t. ensureUpstreamInclude is a no-op if the file already exists,
	// which preserves whatever a deploy script has written there.
	if err := ensureUpstreamInclude(domain, port); err != nil {
		return fmt.Errorf("write upstream include: %w", err)
	}

	config := n.BuildConfig(domain, port, ssl)

	availPath := filepath.Join(n.availDir, domain)
	enabledPath := filepath.Join(n.enabledDir, domain)

	// Write to sites-available
	if err := os.WriteFile(availPath, []byte(config), 0644); err != nil {
		return fmt.Errorf("write nginx config: %w", err)
	}

	// Remove old symlink if exists
	os.Remove(enabledPath)

	// Create symlink to sites-enabled
	if err := os.Symlink(availPath, enabledPath); err != nil {
		return fmt.Errorf("create nginx symlink: %w", err)
	}

	return nil
}

// RemoveConfig removes NGINX config files for a domain
func (n *Nginx) RemoveConfig(domain string) {
	os.Remove(filepath.Join(n.enabledDir, domain))
	os.Remove(filepath.Join(n.availDir, domain))
}

// TestAndReload tests the NGINX configuration and reloads
func (n *Nginx) TestAndReload() error {
	// Test config
	result, err := n.exec.RunBin("nginx", "-t")
	if err != nil {
		return fmt.Errorf("nginx -t: %w", err)
	}
	if result.Code != 0 {
		return fmt.Errorf("nginx config test failed: %s", result.Stderr)
	}

	// Reload
	result, err = n.exec.RunBin("nginx", "-s", "reload")
	if err != nil {
		return fmt.Errorf("nginx reload: %w", err)
	}
	if result.Code != 0 {
		return fmt.Errorf("nginx reload failed: %s", result.Stderr)
	}

	return nil
}

// ReadConfig reads the current NGINX config for a domain (for rollback)
func (n *Nginx) ReadConfig(domain string) (string, error) {
	data, err := os.ReadFile(filepath.Join(n.availDir, domain))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// RestoreConfig writes a previously read config back
func (n *Nginx) RestoreConfig(domain string, content string) error {
	availPath := filepath.Join(n.availDir, domain)
	enabledPath := filepath.Join(n.enabledDir, domain)

	if err := os.WriteFile(availPath, []byte(content), 0644); err != nil {
		return err
	}

	os.Remove(enabledPath)
	return os.Symlink(availPath, enabledPath)
}

// TestAndReloadResult is used by domain handler for testing NGINX with rollback
func (n *Nginx) TestAndReloadWithResult() *models.ExecResult {
	result, err := n.exec.RunBin("nginx", "-t")
	if err != nil {
		return &models.ExecResult{Code: 1, Stderr: err.Error()}
	}
	if result.Code != 0 {
		return result
	}

	reloadResult, err := n.exec.RunBin("nginx", "-s", "reload")
	if err != nil {
		return &models.ExecResult{Code: 1, Stderr: err.Error()}
	}
	return reloadResult
}
