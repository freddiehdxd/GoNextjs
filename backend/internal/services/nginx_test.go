package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const modernCiphers = "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"

func TestBuildConfigTemplates(t *testing.T) {
	n := NewNginx(nil, "/tmp/avail", "/tmp/enabled")
	cases := []struct {
		name string
		cfg  string
		ssl  bool
		want []string
		deny []string
	}{
		{"proxy http", n.BuildConfig("app.example.com", 3001, false), false,
			[]string{"listen 80;", "listen [::]:80;", "proxy_set_header X-Forwarded-Proto $scheme;", "proxy_pass http://app_app_example_com;"},
			[]string{"listen 443", "X-Forwarded-Proto https"}},
		{"proxy https", n.BuildConfig("app.example.com", 3001, true), true,
			[]string{"listen [::]:80;", "listen 443 ssl http2;", "listen [::]:443 ssl http2;", "proxy_set_header X-Forwarded-Proto https;"},
			[]string{"X-Forwarded-Proto $scheme"}},
		{"static http", n.BuildStaticConfig("site.example.com", "/var/www/apps/site/dist", false), false,
			[]string{"listen 80;", "listen [::]:80;", "root /var/www/apps/site/dist;"},
			[]string{"listen 443"}},
		{"static https", n.BuildStaticConfig("site.example.com", "/var/www/apps/site/dist", true), true,
			[]string{"listen [::]:443 ssl http2;", "root /var/www/apps/site/dist;"},
			nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for _, w := range c.want {
				if !strings.Contains(c.cfg, w) {
					t.Errorf("missing %q", w)
				}
			}
			for _, d := range c.deny {
				if strings.Contains(c.cfg, d) {
					t.Errorf("unexpected %q", d)
				}
			}
			if strings.Contains(c.cfg, "HIGH:!aNULL:!MD5") {
				t.Errorf("weak cipher list present")
			}
			if c.ssl {
				for _, w := range []string{
					"ssl_ciphers " + modernCiphers + ";",
					"ssl_prefer_server_ciphers off;",
					"ssl_session_cache shared:PanelSSL:10m;",
					`add_header Strict-Transport-Security "max-age=63072000" always;`,
					"add_header X-Content-Type-Options nosniff always;",
					`add_header Referrer-Policy "strict-origin-when-cross-origin" always;`,
				} {
					if !strings.Contains(c.cfg, w) {
						t.Errorf("ssl template missing %q", w)
					}
				}
			}
			if strings.HasPrefix(c.name, "static") && c.ssl {
				// security headers must be repeated inside location blocks that add their own headers
				if strings.Count(c.cfg, `add_header Strict-Transport-Security "max-age=63072000" always;`) < 3 {
					t.Errorf("HSTS must be repeated in each add_header location block")
				}
				if strings.Count(c.cfg, "Referrer-Policy") < 3 {
					t.Errorf("Referrer-Policy must be repeated in each add_header location block")
				}
			}
		})
	}
}

func TestRemoveConfig_RemovesMixedCaseLeftovers(t *testing.T) {
	avail := t.TempDir()
	enabled := t.TempDir()

	for _, dir := range []string{avail, enabled} {
		if err := os.WriteFile(filepath.Join(dir, "Example.COM"), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "other.com"), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	n := NewNginx(nil, avail, enabled)
	n.RemoveConfig("example.com")

	for _, dir := range []string{avail, enabled} {
		if _, err := os.Stat(filepath.Join(dir, "Example.COM")); !os.IsNotExist(err) {
			t.Errorf("expected Example.COM to be removed from %s", dir)
		}
		if _, err := os.Stat(filepath.Join(dir, "other.com")); err != nil {
			t.Errorf("expected other.com to survive in %s: %v", dir, err)
		}
	}
}
