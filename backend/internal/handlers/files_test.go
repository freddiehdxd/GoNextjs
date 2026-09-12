package handlers

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// windowsPathExpectation: filepath.Base only splits on backslash on Windows.
// On Linux the whole string is one segment containing ':' and '\', which the
// filename regex rejects.
func windowsPathExpectation() string {
	if runtime.GOOS == "windows" {
		return "file.txt"
	}
	return ""
}

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
		{"strip windows path", "C:\\Users\\file.txt", windowsPathExpectation()},
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
	root := t.TempDir()
	appDir := filepath.Join(root, "myapp")
	if err := os.MkdirAll(filepath.Join(appDir, "src", "components"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "myapp2"), 0755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		subPath string
		safe    bool
	}{
		{"valid root", "", true},
		{"valid subdir", "src", true},
		{"valid nested", "src/components/App.tsx", true},
		{"valid missing file", "src/new.txt", true},
		{"double dot in name", "..hidden", true},
		{"encoded traversal is a plain name", "..%2F..%2Fetc%2Fpasswd", true},
		{"traversal up", "../", false},
		{"traversal to other app", "../otherapp/secrets", false},
		{"traversal to etc", "../../../etc/passwd", false},
		{"absolute path", "/etc/passwd", false},
		{"sibling prefix", "../myapp2/.env", false},
		{"sibling prefix nested", "src/../../myapp2/.env", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAppPath(appDir, tt.subPath)
			if (err == nil) != tt.safe {
				t.Fatalf("resolveAppPath(%q) = %q, %v; want safe=%v", tt.subPath, got, err, tt.safe)
			}
			if err == nil && got != filepath.Clean(filepath.Join(appDir, tt.subPath)) {
				t.Errorf("resolved %q, want %q", got, filepath.Clean(filepath.Join(appDir, tt.subPath)))
			}
		})
	}

	t.Run("symlink inside app pointing outside is rejected", func(t *testing.T) {
		outside := filepath.Join(root, "outside")
		if err := os.MkdirAll(outside, 0755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(appDir, "link")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("symlinks not permitted: %v", err)
		}
		if _, err := resolveAppPath(appDir, "link/secret"); err == nil {
			t.Error("expected symlink escape to be rejected")
		}
		if _, err := resolveAppPath(appDir, "link"); err == nil {
			t.Error("expected symlink itself to be rejected")
		}
	})
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
