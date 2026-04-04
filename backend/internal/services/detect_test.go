package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile is a helper to create a file with content inside a temp dir.
func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func TestReadPanelMeta_NotFound(t *testing.T) {
	dir := t.TempDir()
	meta, err := ReadPanelMeta(dir)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if meta.AppType != "" || meta.RootDir != "" {
		t.Errorf("expected zero PanelMeta, got %+v", meta)
	}
}

func TestReadPanelMeta_Valid(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, ".panel_meta", `{"app_type":"vite","root_dir":"/web"}`)
	meta, err := ReadPanelMeta(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "vite" || meta.RootDir != "/web" {
		t.Errorf("unexpected meta: %+v", meta)
	}
}

func TestReadPanelMeta_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, ".panel_meta", `{not valid json`)
	_, err := ReadPanelMeta(dir)
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestDetectAppType_NextConfigFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "next.config.js", `module.exports = {}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "next" || meta.RootDir != "/" {
		t.Errorf("expected next at /, got %+v", meta)
	}
}

func TestDetectAppType_ViteConfigFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "vite.config.ts", `export default {}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "vite" {
		t.Errorf("expected vite, got %+v", meta)
	}
}

func TestDetectAppType_NextDependency(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "package.json", `{"dependencies":{"next":"14.0.0","react":"18.0.0"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "next" {
		t.Errorf("expected next, got %+v", meta)
	}
}

func TestDetectAppType_ViteDependency(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "package.json", `{"devDependencies":{"vite":"5.0.0"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "vite" {
		t.Errorf("expected vite, got %+v", meta)
	}
}

func TestDetectAppType_NodeByStartScript(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "package.json", `{"scripts":{"start":"node server.js"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "node" {
		t.Errorf("expected node, got %+v", meta)
	}
}

func TestDetectAppType_StaticFallback(t *testing.T) {
	dir := t.TempDir()
	// No package.json, no go.mod
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "static" {
		t.Errorf("expected static, got %+v", meta)
	}
}

func TestDetectAppType_GoFallback(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "go.mod", `module example.com/app\n\ngo 1.21\n`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "custom" {
		t.Errorf("expected custom for Go project, got %+v", meta)
	}
}

func TestDetectAppType_SubdirCandidate(t *testing.T) {
	dir := t.TempDir()
	// No package.json at root; vite app in /web
	writeFile(t, dir, "web/vite.config.js", `export default {}`)
	writeFile(t, dir, "web/package.json", `{"devDependencies":{"vite":"5.0.0"},"scripts":{"build":"vite build"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "vite" {
		t.Errorf("expected vite, got %+v", meta)
	}
	if meta.RootDir != "/web" {
		t.Errorf("expected root_dir /web, got %s", meta.RootDir)
	}
}

func TestDetectAppType_RootDirHint(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "web/next.config.mjs", `export default {}`)
	writeFile(t, dir, "web/package.json", `{"dependencies":{"next":"14.0.0"}}`)
	// rootDirHint points directly to /web
	meta, err := DetectAppType(dir, "/web")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "next" || meta.RootDir != "/web" {
		t.Errorf("expected next at /web, got %+v", meta)
	}
}

func TestDetectAppType_AmbiguousCandidates(t *testing.T) {
	dir := t.TempDir()
	// Two equally-scored frontend candidates
	writeFile(t, dir, "web/package.json", `{"devDependencies":{"vite":"5.0.0"},"scripts":{"build":"vite build"}}`)
	writeFile(t, dir, "app/package.json", `{"devDependencies":{"vite":"5.0.0"},"scripts":{"build":"vite build"}}`)
	_, err := DetectAppType(dir, "/")
	if err == nil {
		t.Fatal("expected error for ambiguous candidates, got nil")
	}
	if !strings.Contains(err.Error(), "Multiple app candidates") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestIsStaticType(t *testing.T) {
	tests := []struct {
		appType  string
		startCmd string
		want     bool
	}{
		{"vite", "", true},
		{"static", "", true},
		{"custom", "", true},
		{"custom", "node server.js", false},
		{"next", "", false},
		{"node", "", false},
	}
	for _, tt := range tests {
		got := IsStaticType(tt.appType, tt.startCmd)
		if got != tt.want {
			t.Errorf("IsStaticType(%q, %q) = %v, want %v", tt.appType, tt.startCmd, got, tt.want)
		}
	}
}

func TestDetectAppType_ExpressDependency(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "package.json", `{"dependencies":{"express":"4.18.0"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "node" {
		t.Errorf("expected node for express dep, got %s", meta.AppType)
	}
}

func TestDetectAppType_CustomFallback(t *testing.T) {
	dir := t.TempDir()
	// package.json with no recognisable deps or scripts
	writeFile(t, dir, "package.json", `{"name":"my-lib","version":"1.0.0"}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "custom" {
		t.Errorf("expected custom fallback, got %s", meta.AppType)
	}
}

func TestDetectAppType_RootDirHint_NotFound(t *testing.T) {
	dir := t.TempDir()
	// Hint points at an empty subdir with no recognisable files
	if err := os.MkdirAll(filepath.Join(dir, "empty"), 0755); err != nil {
		t.Fatal(err)
	}
	_, err := DetectAppType(dir, "/empty")
	if err == nil {
		t.Fatal("expected error when hint subdir has no app files")
	}
}

func TestDetectAppType_ClearWinner(t *testing.T) {
	dir := t.TempDir()
	// /web scores +2 (name) +1 (build script) = 3
	writeFile(t, dir, "web/package.json", `{"devDependencies":{"vite":"5.0.0"},"scripts":{"build":"vite build"}}`)
	// /api scores -3 (backend name) = -3
	writeFile(t, dir, "api/package.json", `{"dependencies":{"express":"4.0.0"},"scripts":{"start":"node index.js"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error with clear winner: %v", err)
	}
	if meta.RootDir != "/web" {
		t.Errorf("expected /web to win, got %s", meta.RootDir)
	}
}

func TestDetectAppType_BackendPenalty(t *testing.T) {
	dir := t.TempDir()
	// api dir should score -3
	writeFile(t, dir, "api/package.json", `{"scripts":{"start":"node index.js"}}`)
	// web dir should score +2+1=3
	writeFile(t, dir, "web/package.json", `{"devDependencies":{"vite":"5.0.0"},"scripts":{"build":"vite build"}}`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.RootDir != "/web" {
		t.Errorf("expected /web (not /api) to win, got %s", meta.RootDir)
	}
}

func TestDetectAppType_InvalidPackageJSON(t *testing.T) {
	dir := t.TempDir()
	// Invalid JSON in package.json — should still return "node" (conservative fallback)
	writeFile(t, dir, "package.json", `{not valid json`)
	meta, err := DetectAppType(dir, "/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.AppType != "node" {
		t.Errorf("expected node fallback for invalid JSON, got %s", meta.AppType)
	}
}
