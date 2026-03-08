package handlers

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"valid simple", "file.txt", "file.txt"},
		{"valid with spaces", "my file.txt", "my file.txt"},
		{"valid with hyphens", "my-file.txt", "my-file.txt"},
		{"valid with dots", "file.tar.gz", "file.tar.gz"},
		{"strip path components", "/etc/passwd", "passwd"},
		{"strip windows path", "C:\\Users\\file.txt", "file.txt"},
		{"strip relative path", "../../../etc/passwd", "passwd"},
		{"reject dotfile", ".env", ""},
		{"reject hidden file", ".htaccess", ""},
		{"strip null bytes", "file\x00.txt", "file.txt"},
		{"strip control chars", "file\x01\x02.txt", "file.txt"},
		{"reject empty after strip", "...", ""},
		{"reject special chars", "file@name.txt", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeFilename(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeFilename(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestPathTraversalGuard(t *testing.T) {
	// Simulate the path traversal guard used in file handlers
	appsDir := "/var/www/apps"
	appName := "myapp"
	appDir := filepath.Join(appsDir, appName)

	tests := []struct {
		name    string
		subPath string
		safe    bool
	}{
		{"valid root", "", true},
		{"valid subdir", "src", true},
		{"valid nested", "src/components/App.tsx", true},
		{"traversal up", "../", false},
		{"traversal to other app", "../otherapp/secrets", false},
		{"traversal to etc", "../../../etc/passwd", false},
		{"traversal encoded", "..%2F..%2Fetc%2Fpasswd", true}, // not decoded at filesystem level, safe
		{"absolute path", "/etc/passwd", false},
		{"double dot in name", "..hidden", true}, // valid if it resolves within appDir
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			targetPath := filepath.Join(appDir, tt.subPath)
			resolved, err := filepath.Abs(targetPath)
			safe := err == nil && strings.HasPrefix(resolved, filepath.Clean(appDir))
			if safe != tt.safe {
				t.Errorf("Path %q: resolved=%q, safe=%v, want safe=%v", tt.subPath, resolved, safe, tt.safe)
			}
		})
	}
}

func TestBlockedExtensions(t *testing.T) {
	// Verify dangerous extensions are blocked
	mustBlock := []string{".exe", ".sh", ".bat", ".cmd", ".ps1", ".dll", ".so"}
	for _, ext := range mustBlock {
		if !blockedExtensions[ext] {
			t.Errorf("Extension %q should be blocked", ext)
		}
	}

	// Verify safe extensions are NOT blocked
	safe := []string{".txt", ".js", ".ts", ".json", ".css", ".html", ".md", ".yaml", ".env"}
	for _, ext := range safe {
		if blockedExtensions[ext] {
			t.Errorf("Extension %q should NOT be blocked", ext)
		}
	}
}
