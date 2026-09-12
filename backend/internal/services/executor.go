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
	defaultTimeout = 2 * time.Minute
	timeoutCode    = 124
)

// Allowed shell scripts
var allowedScripts = map[string]bool{
	"install_nginx.sh":    true,
	"install_postgres.sh": true,
	"install_redis.sh":    true,
	"deploy_app.sh":       true,
	"setup_app.sh":        true,
	"create_ssl.sh":       true,
}

// Allowed binaries with absolute paths
var allowedBins = map[string]string{
	"pm2":        "/usr/bin/pm2",
	"nginx":      "/usr/sbin/nginx",
	"certbot":    "/usr/bin/certbot",
	"systemctl":  "/bin/systemctl",
	"psql":       "/usr/bin/psql",
	"pg_dump":    "/usr/bin/pg_dump",
	"pg_restore": "/usr/bin/pg_restore",
	"unzip":      "/usr/bin/unzip",
	"tail":       "/usr/bin/tail",
	"redis-cli":  "/usr/bin/redis-cli",
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
	scriptsDir    string
	appsDir       string
	deployTimeout time.Duration
}

// NewExecutor creates a new executor. deployTimeout bounds deploy/setup scripts;
// everything else uses defaultTimeout.
func NewExecutor(scriptsDir, appsDir string, deployTimeout time.Duration) *Executor {
	if deployTimeout <= 0 {
		deployTimeout = deployTimeout0
	}
	return &Executor{scriptsDir: scriptsDir, appsDir: appsDir, deployTimeout: deployTimeout}
}

// deployTimeout0 is the fallback when no timeout is configured.
const deployTimeout0 = 15 * time.Minute

// runOpts carries the optional parts of a run.
type runOpts struct {
	extraEnv map[string]string // extra KEY=VALUE pairs (keys must be shell-safe)
	stdin    io.Reader         // piped to the child's stdin when non-nil
	stdout   io.Writer         // streams stdout here instead of buffering when non-nil
}

func (e *Executor) scriptTimeout(script string) time.Duration {
	if script == "deploy_app.sh" || script == "setup_app.sh" {
		return e.deployTimeout
	}
	return defaultTimeout
}

// RunScript runs an allowed shell script with arguments
func (e *Executor) RunScript(script string, args ...string) (*models.ExecResult, error) {
	return e.RunScriptEnv(script, nil, args...)
}

// RunScriptEnv runs an allowed shell script with extra environment variables and arguments.
func (e *Executor) RunScriptEnv(script string, extraEnv map[string]string, args ...string) (*models.ExecResult, error) {
	if !allowedScripts[script] {
		return nil, fmt.Errorf("script not allowed: %s", script)
	}
	allArgs := append([]string{e.scriptsDir + "/" + script}, args...)
	return e.run("/bin/bash", allArgs, e.scriptTimeout(script), runOpts{extraEnv: extraEnv})
}

// RunBin runs an allowed binary with arguments
func (e *Executor) RunBin(bin string, args ...string) (*models.ExecResult, error) {
	binPath, ok := allowedBins[bin]
	if !ok {
		return nil, fmt.Errorf("binary not allowed: %s", bin)
	}
	return e.run(binPath, args, defaultTimeout, runOpts{})
}

// RunBinStream runs an allowed binary and streams stdout directly to w.
// Used for large outputs like pg_dump where buffering is not practical.
func (e *Executor) RunBinStream(w io.Writer, bin string, args ...string) error {
	binPath, ok := allowedBins[bin]
	if !ok {
		return fmt.Errorf("binary not allowed: %s", bin)
	}
	res, err := e.run(binPath, args, 5*time.Minute, runOpts{stdout: w})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return fmt.Errorf("exit status %d: %s", res.Code, res.Stderr)
	}
	return nil
}

// RunBinWithStdin runs an allowed binary and pipes r into its stdin.
// Used for operations like pg_restore / psql restore.
func (e *Executor) RunBinWithStdin(r io.Reader, bin string, args ...string) (*models.ExecResult, error) {
	binPath, ok := allowedBins[bin]
	if !ok {
		return nil, fmt.Errorf("binary not allowed: %s", bin)
	}
	return e.run(binPath, args, 10*time.Minute, runOpts{stdin: r})
}

// run executes a command with a restricted environment, a timeout that kills
// the whole process group, and bounded output buffers.
func (e *Executor) run(binary string, args []string, timeout time.Duration, o runOpts) (*models.ExecResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, args...)
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"APPS_DIR=" + e.appsDir,
	}
	for k, v := range o.extraEnv {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	cmd.WaitDelay = 10 * time.Second
	setProcessGroup(cmd)

	if o.stdin != nil {
		cmd.Stdin = o.stdin
	}
	var stdout, stderr bytes.Buffer
	if o.stdout != nil {
		cmd.Stdout = o.stdout
	} else {
		cmd.Stdout = &limitedWriter{buf: &stdout, max: maxOutputSize}
	}
	cmd.Stderr = &limitedWriter{buf: &stderr, max: maxOutputSize}

	err := cmd.Run()
	result := &models.ExecResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			result.Code = timeoutCode
			result.Stderr += "\n... command timed out"
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
