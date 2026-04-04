package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PanelMeta is written by deploy scripts and read by the backend to persist detection results.
type PanelMeta struct {
	AppType string `json:"app_type"`
	RootDir string `json:"root_dir"`
}

// ReadPanelMeta reads .panel_meta from the app directory.
// Returns a zero-value PanelMeta and no error if the file doesn't exist.
func ReadPanelMeta(appDir string) (PanelMeta, error) {
	data, err := os.ReadFile(filepath.Join(appDir, ".panel_meta"))
	if os.IsNotExist(err) {
		return PanelMeta{}, nil
	}
	if err != nil {
		return PanelMeta{}, err
	}
	var m PanelMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return PanelMeta{}, err
	}
	return m, nil
}

// DetectAppType scans dir for the app type and effective root directory.
// rootDirHint: if non-empty and not "/", skip scanning and detect only from that subdir.
func DetectAppType(repoDir, rootDirHint string) (PanelMeta, error) {
	if rootDirHint != "" && rootDirHint != "/" {
		workDir := filepath.Join(repoDir, filepath.FromSlash(strings.TrimPrefix(rootDirHint, "/")))
		t, ok := detectFromDir(workDir)
		if !ok {
			return PanelMeta{}, fmt.Errorf("no package.json or config files found in %s", rootDirHint)
		}
		return PanelMeta{AppType: t, RootDir: rootDirHint}, nil
	}

	// Try repo root first
	if t, ok := detectFromDir(repoDir); ok {
		return PanelMeta{AppType: t, RootDir: "/"}, nil
	}

	// Scan up to depth 2, excluding noise dirs
	excluded := map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, ".next": true}
	type candidate struct {
		relPath string
		score   int
		appType string
	}
	var candidates []candidate

	entries1, _ := os.ReadDir(repoDir)
	for _, e1 := range entries1 {
		if !e1.IsDir() || (e1.Type()&os.ModeSymlink != 0) || excluded[e1.Name()] {
			continue
		}
		dir1 := filepath.Join(repoDir, e1.Name())
		if t, ok := detectFromDir(dir1); ok {
			candidates = append(candidates, candidate{
				relPath: "/" + e1.Name(),
				score:   scoreDir(e1.Name(), dir1),
				appType: t,
			})
		}
		// Depth 2
		entries2, _ := os.ReadDir(dir1)
		for _, e2 := range entries2 {
			if !e2.IsDir() || (e2.Type()&os.ModeSymlink != 0) || excluded[e2.Name()] {
				continue
			}
			dir2 := filepath.Join(dir1, e2.Name())
			if t, ok := detectFromDir(dir2); ok {
				candidates = append(candidates, candidate{
					relPath: "/" + e1.Name() + "/" + e2.Name(),
					score:   scoreDir(e2.Name(), dir2),
					appType: t,
				})
			}
		}
	}

	if len(candidates) == 0 {
		// Check for Go project
		if _, err := os.Stat(filepath.Join(repoDir, "go.mod")); err == nil {
			return PanelMeta{AppType: "custom", RootDir: "/"}, nil
		}
		return PanelMeta{AppType: "static", RootDir: "/"}, nil
	}

	if len(candidates) == 1 {
		return PanelMeta{AppType: candidates[0].appType, RootDir: candidates[0].relPath}, nil
	}

	// Find best candidate
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.score > best.score {
			best = c
		}
	}
	// Check for clear winner (gap >= 2 vs all others)
	for _, c := range candidates {
		if c.relPath != best.relPath && best.score-c.score < 2 {
			paths := make([]string, len(candidates))
			for i, cc := range candidates {
				paths[i] = fmt.Sprintf("%s (score %d)", cc.relPath, cc.score)
			}
			return PanelMeta{}, fmt.Errorf(
				"Multiple app candidates found: %s — set root_dir to specify which app to deploy",
				strings.Join(paths, ", "),
			)
		}
	}
	return PanelMeta{AppType: best.appType, RootDir: best.relPath}, nil
}

// detectFromDir returns (appType, true) if dir looks like a JS/TS app, ("", false) otherwise.
func detectFromDir(dir string) (string, bool) {
	// Config file detection — highest priority
	for _, f := range []string{"next.config.js", "next.config.ts", "next.config.mjs"} {
		if fileExists(filepath.Join(dir, f)) {
			return "next", true
		}
	}
	for _, f := range []string{"vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"} {
		if fileExists(filepath.Join(dir, f)) {
			return "vite", true
		}
	}

	pkgPath := filepath.Join(dir, "package.json")
	if !fileExists(pkgPath) {
		return "", false
	}

	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return "node", true // has package.json but can't read — assume node
	}

	var pkg struct {
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
		Scripts         struct {
			Start string `json:"start"`
			Build string `json:"build"`
		} `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return "node", true
	}

	allDeps := make(map[string]string)
	for k, v := range pkg.Dependencies {
		allDeps[k] = v
	}
	for k, v := range pkg.DevDependencies {
		allDeps[k] = v
	}

	if _, ok := allDeps["next"]; ok {
		return "next", true
	}
	if _, ok := allDeps["vite"]; ok {
		return "vite", true
	}

	// Build script signals
	if strings.Contains(pkg.Scripts.Build, "next build") {
		return "next", true
	}
	if strings.Contains(pkg.Scripts.Build, "vite build") {
		return "vite", true
	}

	// Node: has a start script that isn't a frontend server
	if pkg.Scripts.Start != "" &&
		!strings.Contains(pkg.Scripts.Start, "vite preview") &&
		!strings.Contains(pkg.Scripts.Start, "next start") {
		return "node", true
	}

	for _, backend := range []string{"express", "fastify", "koa", "hapi"} {
		if _, ok := allDeps[backend]; ok {
			return "node", true
		}
	}

	return "custom", true
}

// scoreDir scores a candidate directory for frontend relevance.
func scoreDir(name, dir string) int {
	score := 0
	for _, n := range []string{"web", "frontend", "app", "client", "ui"} {
		if strings.EqualFold(name, n) {
			score += 2
			break
		}
	}
	for _, n := range []string{"api", "server", "backend"} {
		if strings.EqualFold(name, n) {
			score -= 3
			break
		}
	}
	// Has build script
	pkgPath := filepath.Join(dir, "package.json")
	if data, err := os.ReadFile(pkgPath); err == nil {
		var pkg struct {
			Scripts map[string]string `json:"scripts"`
		}
		if json.Unmarshal(data, &pkg) == nil && pkg.Scripts["build"] != "" {
			score++
		}
	}
	return score
}

// fileExists returns true if path exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// IsStaticType returns true for app types that are served as static files (no PM2 process).
func IsStaticType(appType, startCmd string) bool {
	if appType == "static" || appType == "vite" {
		return true
	}
	if appType == "custom" && startCmd == "" {
		return true
	}
	return false
}
