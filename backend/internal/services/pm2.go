package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"panel-backend/internal/models"
)

// PM2 manages PM2 process operations
type PM2 struct {
	exec    *Executor
	pm2Home string
}

// NewPM2 creates a new PM2 service
func NewPM2(exec *Executor) *PM2 {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/root"
	}
	return &PM2{exec: exec, pm2Home: filepath.Join(home, ".pm2")}
}

// pm2DumpEntry represents a process entry in PM2's dump.pm2 file
type pm2DumpEntry struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	PmUptime   int64  `json:"pm_uptime"`
	PmPidPath  string `json:"pm_pid_path"`
}

// pm2RawProcess represents the raw JSON structure from pm2 jlist
type pm2RawProcess struct {
	Name  string `json:"name"`
	PmID  int    `json:"pm_id"`
	Pm2Env struct {
		Status  string `json:"status"`
		PmUptime int64  `json:"pm_uptime"`
	} `json:"pm2_env"`
	Monit struct {
		CPU    float64 `json:"cpu"`
		Memory int64   `json:"memory"`
	} `json:"monit"`
}

// ListFromProc reads PM2 process info directly from ~/.pm2/dump.pm2 + /proc/[pid]/stat.
// Zero subprocess overhead — just file reads.
func (p *PM2) ListFromProc() ([]models.Pm2Process, error) {
	dumpPath := filepath.Join(p.pm2Home, "dump.pm2")
	data, err := os.ReadFile(dumpPath)
	if err != nil {
		return nil, fmt.Errorf("read dump.pm2: %w", err)
	}

	var entries []pm2DumpEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("parse dump.pm2: %w", err)
	}

	processes := make([]models.Pm2Process, 0, len(entries))
	for i, e := range entries {
		proc := models.Pm2Process{
			Name:   e.Name,
			PmID:   i,
			Status: e.Status,
			Uptime: e.PmUptime,
		}

		// Read PID from the pid file
		pidPath := e.PmPidPath
		if pidPath == "" {
			pidPath = filepath.Join(p.pm2Home, "pids", fmt.Sprintf("%s-%d.pid", e.Name, i))
		}
		pidData, err := os.ReadFile(pidPath)
		if err != nil {
			// Process might be stopped — no pid file
			proc.Status = "stopped"
			processes = append(processes, proc)
			continue
		}

		pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
		if err != nil || pid <= 0 {
			proc.Status = "stopped"
			processes = append(processes, proc)
			continue
		}

		// Check if process is actually alive
		statPath := fmt.Sprintf("/proc/%d/stat", pid)
		statData, err := os.ReadFile(statPath)
		if err != nil {
			// Process died but PM2 hasn't noticed yet
			proc.Status = "stopped"
			processes = append(processes, proc)
			continue
		}

		// Parse /proc/[pid]/stat for CPU time and memory
		// Format: pid (comm) state ... field14=utime field15=stime ... field24=rss
		statStr := string(statData)
		closeIdx := strings.LastIndex(statStr, ")")
		if closeIdx >= 0 && closeIdx+2 < len(statStr) {
			fields := strings.Fields(statStr[closeIdx+2:])
			if len(fields) >= 22 {
				// RSS is field 24 (0-indexed from after comm: index 21)
				rss, _ := strconv.ParseInt(fields[21], 10, 64)
				proc.Memory = rss * int64(os.Getpagesize())
			}
		}

		proc.Status = "online"
		processes = append(processes, proc)
	}

	return processes, nil
}

// List returns all PM2 processes via pm2 jlist (subprocess — use ListFromProc for stats)
func (p *PM2) List() ([]models.Pm2Process, error) {
	result, err := p.exec.RunBin("pm2", "jlist")
	if err != nil {
		return nil, fmt.Errorf("pm2 jlist: %w", err)
	}

	if result.Code != 0 {
		return nil, fmt.Errorf("pm2 jlist failed: %s", result.Stderr)
	}

	stdout := strings.TrimSpace(result.Stdout)
	if stdout == "" || stdout == "[]" {
		return []models.Pm2Process{}, nil
	}

	var raw []pm2RawProcess
	if err := json.Unmarshal([]byte(stdout), &raw); err != nil {
		return nil, fmt.Errorf("parse pm2 jlist: %w", err)
	}

	processes := make([]models.Pm2Process, 0, len(raw))
	for _, r := range raw {
		processes = append(processes, models.Pm2Process{
			Name:   r.Name,
			PmID:   r.PmID,
			Status: r.Pm2Env.Status,
			CPU:    r.Monit.CPU,
			Memory: r.Monit.Memory,
			Uptime: r.Pm2Env.PmUptime,
		})
	}

	return processes, nil
}

// Action performs a PM2 action (start, stop, restart, delete) on an app
func (p *PM2) Action(action, appName string) (*models.ExecResult, error) {
	validActions := map[string]bool{
		"start": true, "stop": true, "restart": true, "reload": true, "delete": true,
	}
	if !validActions[action] {
		return nil, fmt.Errorf("invalid pm2 action: %s", action)
	}

	return p.exec.RunBin("pm2", action, appName)
}

// Logs retrieves PM2 logs for an app
func (p *PM2) Logs(appName string, lines int) (string, error) {
	if lines <= 0 {
		lines = 100
	}

	result, err := p.exec.RunBin("pm2", "logs", appName,
		"--lines", fmt.Sprintf("%d", lines), "--nostream")
	if err != nil {
		return "", fmt.Errorf("pm2 logs: %w", err)
	}

	// Combine stdout and stderr (PM2 logs outputs to both)
	output := result.Stdout
	if result.Stderr != "" {
		output = output + "\n" + result.Stderr
	}

	return strings.TrimSpace(output), nil
}
