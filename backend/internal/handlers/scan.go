package handlers

import (
	"bufio"
	"fmt"
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

// findDomainsFor returns the names of NGINX site files in availDir that proxy
// to port (when port > 0) or serve a root at or under dirPath.
func findDomainsFor(availDir string, port int, dirPath string) []string {
	entries, err := os.ReadDir(availDir)
	if err != nil {
		return []string{}
	}
	proxyNeedle := ""
	upstreamNeedle := ""
	if port > 0 {
		proxyNeedle = fmt.Sprintf("proxy_pass http://127.0.0.1:%d;", port)
		upstreamNeedle = fmt.Sprintf("server 127.0.0.1:%d;", port)
	}
	cleanDir := filepath.Clean(dirPath)
	matches := []string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(availDir, e.Name()))
		if err != nil {
			continue
		}
		content := string(data)
		if proxyNeedle != "" && strings.Contains(content, proxyNeedle) {
			matches = append(matches, e.Name())
			continue
		}
		matched := false
		if upstreamNeedle != "" {
			for _, line := range strings.Split(content, "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "include ") {
					continue
				}
				includePath := strings.TrimSpace(strings.TrimPrefix(line, "include "))
				includePath = strings.TrimSuffix(includePath, ";")
				includePath = strings.Trim(includePath, "\"")
				if incData, err := os.ReadFile(includePath); err == nil && strings.Contains(string(incData), upstreamNeedle) {
					matches = append(matches, e.Name())
					matched = true
					break
				}
			}
		}
		if matched {
			continue
		}
		for _, line := range strings.Split(content, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "root ") {
				continue
			}
			root := filepath.Clean(strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "root ")), ";"))
			if root == cleanDir || strings.HasPrefix(root, cleanDir+string(filepath.Separator)) {
				matches = append(matches, e.Name())
				break
			}
		}
	}
	sort.Strings(matches)
	return matches
}

// choosePort picks the port for an imported app.
//   - requested != 0: must be in range and unused, else error.
//   - else detected, when in range and unused.
//   - else the first free port in range.
func choosePort(requested, detected int, used map[int]bool, start, end int) (int, error) {
	inRange := func(p int) bool { return p >= start && p <= end }
	if requested != 0 {
		if !inRange(requested) {
			return 0, fmt.Errorf("port %d is outside the allowed range %d-%d", requested, start, end)
		}
		if used[requested] {
			return 0, fmt.Errorf("port %d is already used by another app", requested)
		}
		return requested, nil
	}
	if detected != 0 && inRange(detected) && !used[detected] {
		return detected, nil
	}
	for p := start; p <= end; p++ {
		if !used[p] {
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free ports available in range %d-%d", start, end)
}
