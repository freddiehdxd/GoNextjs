package handlers

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestListUnmanagedDirs(t *testing.T) {
	root := t.TempDir()
	mkdir(t, filepath.Join(root, "alpha"))
	mkdir(t, filepath.Join(root, "beta"))
	mkdir(t, filepath.Join(root, "Bad_Name"))
	mkdir(t, filepath.Join(root, ".hidden"))
	writeFile(t, filepath.Join(root, "notes.txt"), "x")

	// Symlinked directory must be skipped (skip test if symlinks unsupported, e.g. Windows without privilege)
	linkTarget := t.TempDir()
	symlinkOK := os.Symlink(linkTarget, filepath.Join(root, "linked")) == nil

	got, err := listUnmanagedDirs(root, map[string]bool{"beta": true})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Bad_Name", "alpha"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if symlinkOK {
		for _, n := range got {
			if n == "linked" {
				t.Errorf("symlinked dir must be skipped")
			}
		}
	}
}

func TestListUnmanagedDirsMissingRoot(t *testing.T) {
	_, err := listUnmanagedDirs(filepath.Join(t.TempDir(), "nope"), nil)
	if err == nil {
		t.Error("expected error for missing apps dir")
	}
}

func TestDirSize(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), "12345")                     // 5
	writeFile(t, filepath.Join(root, "src", "b.txt"), "123")                // 3
	writeFile(t, filepath.Join(root, "node_modules", "x.js"), "xxxxxxxxxx") // excluded
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "xxxxxxxxxx")         // excluded
	writeFile(t, filepath.Join(root, "dist", "i.html"), "xxxxxxxxxx")       // excluded
	if got := dirSize(root); got != 8 {
		t.Errorf("dirSize = %d, want 8", got)
	}
	if got := dirSize(filepath.Join(root, "missing")); got != 0 {
		t.Errorf("dirSize(missing) = %d, want 0", got)
	}
}

func TestReadGitInfo(t *testing.T) {
	t.Run("branch and origin", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".git", "HEAD"), "ref: refs/heads/develop\n")
		writeFile(t, filepath.Join(dir, ".git", "config"), `[core]
	repositoryformatversion = 0
[remote "origin"]
	url = https://github.com/acme/site.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "develop"]
	remote = origin
`)
		got := readGitInfo(dir)
		if got == nil || got.RepoURL != "https://github.com/acme/site.git" || got.Branch != "develop" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("detached head, no origin", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
		writeFile(t, filepath.Join(dir, ".git", "config"), "[core]\n\tbare = false\n")
		got := readGitInfo(dir)
		if got == nil || got.RepoURL != "" || got.Branch != "" {
			t.Errorf("got %+v, want empty fields", got)
		}
	})
	t.Run("no .git", func(t *testing.T) {
		if got := readGitInfo(t.TempDir()); got != nil {
			t.Errorf("got %+v, want nil", got)
		}
	})
}

func TestParseEcosystemPort(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"env: {\n      NODE_ENV: 'production',\n      PORT:     '3004',\n    },", 3004},
		{`PORT: "3010"`, 3010},
		{"PORT: 3011,", 3011},
		{"name: 'x'", 0},
		{"", 0},
	}
	for _, tt := range tests {
		if got := parseEcosystemPort(tt.in); got != tt.want {
			t.Errorf("parseEcosystemPort(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestDetectPort(t *testing.T) {
	t.Run("ecosystem wins over env", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "ecosystem.config.js"), "module.exports={apps:[{env:{PORT:'3004'}}]}")
		writeFile(t, filepath.Join(dir, ".env"), "PORT=3999\n")
		if got := detectPort(dir); got != 3004 {
			t.Errorf("got %d, want 3004", got)
		}
	})
	t.Run("env fallback", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".env"), "FOO=bar\nPORT=\"3020\"\n")
		if got := detectPort(dir); got != 3020 {
			t.Errorf("got %d, want 3020", got)
		}
	})
	t.Run("nothing", func(t *testing.T) {
		if got := detectPort(t.TempDir()); got != 0 {
			t.Errorf("got %d, want 0", got)
		}
	})
}
