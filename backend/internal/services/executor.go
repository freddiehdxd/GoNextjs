package services

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"panel-backend/internal/models"
)

const (
	maxOutputSize  = 10 * 1024 * 1024 // 10MB
	deployTimeout  = 5 * time.Minute
	defaultTimeout = 2 * time.Minute
	timeoutCode    = 124
)

// Allowed shell scripts
var allowedScripts = map[string]bool{
	"install_nginx.sh":    true,
	"install_postgres.sh": true,
	"install_redis.sh":    true,
	"deploy_next_app.sh":  true,
	"setup_app.sh":        true,
	"create_ssl.sh":       true,
}

// Allowed binaries with absolute paths
var allowedBins = map[string]string{
	"pm2":       "/usr/bin/pm2",
	"nginx":     "/usr/sbin/nginx",
	"certbot":   "/usr/bin/certbot",
	"systemctl": "/bin/systemctl",
	"psql":       "/usr/bin/psql",
	"pg_dump":    "/usr/bin/pg_dump",
	"pg_restore": "/usr/bin/pg_restore",
	"unzip":      "/usr/bin/unzip",
	"tail":       "/usr/bin/tail",
	"redis-cli": "/usr/bin/redis-cli",
	"tar":        "/bin/tar",
}

// Validation regexes
var (
	appNameRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	domainRegex  = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`)
	pgIdentRegex = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
)

// Executor runs shell commands safely
type Executor struct {
	scriptsDir string
	appsDir    string
}

// NewExecutor creates a new executor
func NewExecutor(scriptsDir, appsDir string) *Executor {
	return &Executor{
		scriptsDir: scriptsDir,
		appsDir:    appsDir,
	}
}

// RunScript runs an allowed shell script with arguments
func (e *Executor) RunScript(script string, args ...string) (*models.ExecResult, error) {
	if !allowedScripts[script] {
		return nil, fmt.Errorf("script not allowed: %s", script)
	}

	scriptPath := e.scriptsDir + "/" + script
	allArgs := append([]string{scriptPath}, args...)

	timeout := defaultTimeout
	if script == "deploy_next_app.sh" || script == "setup_app.sh" {
		timeout = deployTimeout
	}

	return e.spawnSafe("/bin/bash", allArgs, timeout)
}

// RunBin runs an allowed binary with arguments
func (e *Executor) RunBin(bin string, args ...string) (*models.ExecResult, error) {
	binPath, ok := allowedBins[bin]
	if !ok {
		return nil, fmt.Errorf("binary not allowed: %s", bin)
	}

	return e.spawnSafe(binPath, args, defaultTimeout)
}

// spawnSafe executes a command safely with timeout and output limits
func (e *Executor) spawnSafe(binary string, args []string, timeout time.Duration) (*models.ExecResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, args...)

	// Set restricted environment
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"APPS_DIR=" + e.appsDir,
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, max: maxOutputSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxOutputSize}

	err := cmd.Run()

	result := &models.ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
		Code:   0,
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result.Code = timeoutCode
			result.Stderr = result.Stderr + "\n... command timed out"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.Code = exitErr.ExitCode()
		} else {
			result.Code = 1
			result.Stderr = err.Error()
		}
	}

	return result, nil
}

// limitedWriter limits the amount of data written to a buffer
type limitedWriter struct {
	buf     *bytes.Buffer
	max     int
	written int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	remaining := w.max - w.written
	if remaining <= 0 {
		return len(p), nil // silently discard
	}
	if len(p) > remaining {
		p = p[:remaining]
		w.buf.Write(p)
		w.buf.WriteString("\n... [output truncated at 10MB]")
		w.written = w.max
		return len(p), nil
	}
	n, err := w.buf.Write(p)
	w.written += n
	return n, err
}

// RunBinStream runs an allowed binary and streams stdout directly to the provided writer.
// Used for large outputs like pg_dump where buffering is not practical.
func (e *Executor) RunBinStream(w io.Writer, bin string, args ...string) error {
	binPath, ok := allowedBins[bin]
	if !ok {
		return fmt.Errorf("binary not allowed: %s", bin)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, args...)
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
	}
	cmd.Stdout = w

	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxOutputSize}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%v: %s", err, stderr.String())
	}
	return nil
}

// RunBinWithStdin runs an allowed binary and pipes the provided reader into stdin.
// Used for operations like pg_restore / psql restore.
func (e *Executor) RunBinWithStdin(r io.Reader, bin string, args ...string) (*models.ExecResult, error) {
	binPath, ok := allowedBins[bin]
	if !ok {
		return nil, fmt.Errorf("binary not allowed: %s", bin)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, binPath, args...)
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
	}
	cmd.Stdin = r

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, max: maxOutputSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxOutputSize}

	err := cmd.Run()
	result := &models.ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
		Code:   0,
	}

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result.Code = timeoutCode
			result.Stderr = result.Stderr + "\n... command timed out"
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.Code = exitErr.ExitCode()
		} else {
			result.Code = 1
			result.Stderr = err.Error()
		}
	}

	return result, nil
}

// ValidateAppName validates an application name
func ValidateAppName(name string) bool {
	return appNameRegex.MatchString(name)
}

// ValidateDomain validates a domain name
func ValidateDomain(domain string) bool {
	return domainRegex.MatchString(strings.ToLower(domain))
}

// ValidatePgIdentifier validates a PostgreSQL identifier
func ValidatePgIdentifier(name string) bool {
	return pgIdentRegex.MatchString(name)
}
