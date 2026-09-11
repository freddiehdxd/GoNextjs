package handlers

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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

// GitInfo is what the scan reports about a directory's git checkout.
type GitInfo struct {
	RepoURL string `json:"repo_url"`
	Branch  string `json:"branch"`
}

// readGitInfo reads .git/HEAD and .git/config directly. Returns nil when the
// directory is not a git checkout. Detached HEAD yields Branch == "".
func readGitInfo(dir string) *GitInfo {
	headData, err := os.ReadFile(filepath.Join(dir, ".git", "HEAD"))
	if err != nil {
		return nil
	}
	info := &GitInfo{}
	head := strings.TrimSpace(string(headData))
	if strings.HasPrefix(head, "ref: refs/heads/") {
		info.Branch = strings.TrimPrefix(head, "ref: refs/heads/")
	}

	cfg, err := os.Open(filepath.Join(dir, ".git", "config"))
	if err != nil {
		return info
	}
	defer cfg.Close()

	inOrigin := false
	scanner := bufio.NewScanner(cfg)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			inOrigin = line == `[remote "origin"]`
			continue
		}
		if inOrigin && strings.HasPrefix(line, "url") {
			if _, val, ok := strings.Cut(line, "="); ok {
				info.RepoURL = strings.TrimSpace(val)
				break
			}
		}
	}
	return info
}

var ecosystemPortRe = regexp.MustCompile(`PORT:\s*['"]?(\d+)`)

// parseEcosystemPort extracts the PORT value from ecosystem.config.js content.
func parseEcosystemPort(content string) int {
	m := ecosystemPortRe.FindStringSubmatch(content)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// detectPort returns the port a directory appears to use: ecosystem.config.js
// first, then PORT= in .env, else 0.
func detectPort(dir string) int {
	if data, err := os.ReadFile(filepath.Join(dir, "ecosystem.config.js")); err == nil {
		if p := parseEcosystemPort(string(data)); p > 0 {
			return p
		}
	}
	if vars, err := parseEnvFile(filepath.Join(dir, ".env")); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(vars["PORT"])); err == nil && n > 0 {
			return n
		}
	}
	return 0
}
