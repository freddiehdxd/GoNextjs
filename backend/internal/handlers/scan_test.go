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
