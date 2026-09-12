package services

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"panel-backend/internal/models"
)

// WriteEnvFile writes environment variables to {appsDir}/{appName}/.env.
// If envVars is empty, removes the .env file.
// This file is read by deploy/setup scripts and injected into ecosystem.config.js.
func WriteEnvFile(appsDir, appName string, envVars map[string]string) error {
	appDir := filepath.Join(appsDir, appName)
	if err := os.MkdirAll(appDir, 0755); err != nil {
		return fmt.Errorf("create app dir: %w", err)
	}

	envPath := filepath.Join(appDir, ".env")

	if len(envVars) == 0 {
		os.Remove(envPath) // best-effort
		return nil
	}

	var lines []string
	for k, v := range envVars {
		if strings.ContainsAny(v, " \t\n\"'\\$#") {
			v = `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
		}
		lines = append(lines, fmt.Sprintf("%s=%s", k, v))
	}

	content := strings.Join(lines, "\n") + "\n"
	return os.WriteFile(envPath, []byte(content), 0600)
}

// AppScriptEnv returns the environment the deploy/setup scripts read for an app.
func AppScriptEnv(app *models.App) map[string]string {
	return map[string]string{
		"APP_TYPE":    app.AppType,
		"ROOT_DIR":    app.RootDir,
		"OUTPUT_DIR":  app.OutputDir,
		"BUILD_CMD":   app.BuildCmd,
		"START_CMD":   app.StartCmd,
		"INSTALL_CMD": app.InstallCmd,
	}
}

// DeployApp writes the .env file and runs deploy_app.sh for the given app.
// Used by the cron scheduler; HTTP handlers call WriteEnvFile directly.
func DeployApp(app *models.App, exec *Executor, appsDir string) (*models.ExecResult, error) {
	if err := WriteEnvFile(appsDir, app.Name, app.EnvVars); err != nil {
		log.Printf("[warn] DeployApp: failed to write .env for %s: %v", app.Name, err)
	}
	return exec.RunScriptEnv("deploy_app.sh", AppScriptEnv(app),
		app.Name, app.RepoURL, app.Branch,
		fmt.Sprintf("%d", app.Port), "restart", fmt.Sprintf("%d", app.MaxMemory))
}
