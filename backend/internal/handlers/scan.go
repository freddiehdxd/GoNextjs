package handlers

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// scanExcludedDirs are skipped when sizing directories (same set detect.go ignores).
var scanExcludedDirs = map[string]bool{
	"node_modules": true, ".git": true, ".next": true, "dist": true, "build": true,
}

// listUnmanagedDirs returns the sorted names of real directories directly under
// appsDir that are not dot-directories, not symlinks, and not in managed.
func listUnmanagedDirs(appsDir string, managed map[string]bool) ([]string, error) {
	entries, err := os.ReadDir(appsDir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") || managed[name] {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

// dirSize sums regular-file sizes under root, skipping scanExcludedDirs.
// Returns 0 if root is missing or unreadable.
func dirSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() {
			if path != root && scanExcludedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if info, err := d.Info(); err == nil && info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total
}
