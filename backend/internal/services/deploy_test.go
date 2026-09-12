package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"panel-backend/internal/models"
)

func TestWriteEnvFile_CreatesFile(t *testing.T) {
	dir := t.TempDir()
	appName := "myapp"
	envVars := map[string]string{
		"PORT":     "3000",
		"NODE_ENV": "production",
	}

	err := WriteEnvFile(dir, appName, envVars)
	if err != nil {
		t.Fatalf("WriteEnvFile error: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(dir, appName, ".env"))
	if err != nil {
		t.Fatalf("Read .env: %v", err)
	}

	got := string(content)
	if !strings.Contains(got, "PORT=3000") {
		t.Errorf("Expected PORT=3000 in .env, got:\n%s", got)
	}
	if !strings.Contains(got, "NODE_ENV=production") {
		t.Errorf("Expected NODE_ENV=production in .env, got:\n%s", got)
	}
}

func TestWriteEnvFile_RemovesFileWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	appName := "myapp"

	os.MkdirAll(filepath.Join(dir, appName), 0755)
	os.WriteFile(filepath.Join(dir, appName, ".env"), []byte("FOO=bar\n"), 0600)

	err := WriteEnvFile(dir, appName, map[string]string{})
	if err != nil {
		t.Fatalf("WriteEnvFile error: %v", err)
	}

	_, err = os.Stat(filepath.Join(dir, appName, ".env"))
	if !os.IsNotExist(err) {
		t.Error("Expected .env to be removed when envVars is empty")
	}
}

func TestWriteEnvFile_QuotesSpecialChars(t *testing.T) {
	dir := t.TempDir()
	err := WriteEnvFile(dir, "app", map[string]string{
		"DB_URL": "postgres://user:p@ss word@host/db",
	})
	if err != nil {
		t.Fatalf("WriteEnvFile error: %v", err)
	}
	content, _ := os.ReadFile(filepath.Join(dir, "app", ".env"))
	if !strings.Contains(string(content), `"`) {
		t.Errorf("Expected value with spaces to be quoted, got: %s", content)
	}
}

func TestAppScriptEnv(t *testing.T) {
	app := &models.App{
		AppType: "vite", RootDir: "/web", OutputDir: "build",
		BuildCmd: "npm run build", StartCmd: "node s.js", InstallCmd: "pnpm i",
	}
	got := AppScriptEnv(app)
	want := map[string]string{
		"APP_TYPE": "vite", "ROOT_DIR": "/web", "OUTPUT_DIR": "build",
		"BUILD_CMD": "npm run build", "START_CMD": "node s.js", "INSTALL_CMD": "pnpm i",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d keys, want %d: %v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}
