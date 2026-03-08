package services

import (
	"fmt"
	"os"
	"path/filepath"

	"panel-backend/internal/models"
)

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

// BuildConfig generates an NGINX server block configuration
func (n *Nginx) BuildConfig(domain string, port int, ssl bool) string {
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

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
`, domain, domain, domain, domain, port)
	}

	return fmt.Sprintf(`# Managed by Panel -- do not edit manually
server {
    listen 80;
    server_name %s;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
`, domain, port)
}

// WriteConfig writes NGINX config and creates symlink
func (n *Nginx) WriteConfig(domain string, port int, ssl bool) error {
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
