package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"panel-backend/internal/config"
)

const (
	panelDir      = "/opt/panel"
	updateLogFile = "/var/log/panel/update.log"
	updateTimeout = 10 * time.Minute
)

// UpdateHandler handles panel self-update routes
type UpdateHandler struct {
	cfg       *config.Config
	mu        sync.Mutex
	updating  bool
}

// NewUpdateHandler creates a new update handler
func NewUpdateHandler(cfg *config.Config) *UpdateHandler {
	return &UpdateHandler{cfg: cfg}
}

// Check handles GET /api/update/check
// Compares local HEAD with remote HEAD to detect available updates
func (h *UpdateHandler) Check(w http.ResponseWriter, r *http.Request) {
	// Get local HEAD
	localCmd := exec.Command("/usr/bin/git", "-C", panelDir, "rev-parse", "HEAD")
	localOut, err := localCmd.Output()
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to read local version")
		return
	}
	localHead := strings.TrimSpace(string(localOut))

	// Get local commit info
	localMsgCmd := exec.Command("/usr/bin/git", "-C", panelDir, "log", "-1", "--format=%s|%ci")
	localMsgOut, _ := localMsgCmd.Output()
	localParts := strings.SplitN(strings.TrimSpace(string(localMsgOut)), "|", 2)
	localMsg := ""
	localDate := ""
	if len(localParts) >= 1 {
		localMsg = localParts[0]
	}
	if len(localParts) >= 2 {
		localDate = localParts[1]
	}

	// Fetch remote
	fetchCmd := exec.Command("/usr/bin/git", "-C", panelDir, "fetch", "origin", "main")
	fetchCmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"GIT_TERMINAL_PROMPT=0",
	}
	if err := fetchCmd.Run(); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch remote updates")
		return
	}

	// Get remote HEAD
	remoteCmd := exec.Command("/usr/bin/git", "-C", panelDir, "rev-parse", "origin/main")
	remoteOut, err := remoteCmd.Output()
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to read remote version")
		return
	}
	remoteHead := strings.TrimSpace(string(remoteOut))

	updateAvailable := localHead != remoteHead

	// Count running user apps (everything except panel-backend)
	userApps := countUserApps()

	result := map[string]interface{}{
		"currentVersion":  localHead[:8],
		"currentCommit":   localMsg,
		"currentDate":     localDate,
		"remoteVersion":   remoteHead[:8],
		"updateAvailable": updateAvailable,
		"updating":        h.updating,
		"runningApps":     userApps,
	}

	// If update available, get the commit log between local and remote
	if updateAvailable {
		logCmd := exec.Command("/usr/bin/git", "-C", panelDir, "log",
			"--oneline", "--no-decorate",
			localHead+".."+remoteHead)
		logOut, _ := logCmd.Output()
		commits := []map[string]string{}
		for _, line := range strings.Split(strings.TrimSpace(string(logOut)), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, " ", 2)
			if len(parts) == 2 {
				commits = append(commits, map[string]string{
					"hash":    parts[0],
					"message": parts[1],
				})
			}
		}
		result["commits"] = commits
		result["commitCount"] = len(commits)
	}

	Success(w, result)
}

// Apply handles POST /api/update/apply
// Runs the update script and streams output via SSE
func (h *UpdateHandler) Apply(w http.ResponseWriter, r *http.Request) {
	// Prevent concurrent updates
	h.mu.Lock()
	if h.updating {
		h.mu.Unlock()
		Error(w, http.StatusConflict, "Update already in progress")
		return
	}
	h.updating = true
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		h.updating = false
		h.mu.Unlock()
	}()

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable NGINX buffering

	flusher, ok := w.(http.Flusher)
	if !ok {
		Error(w, http.StatusInternalServerError, "Streaming not supported")
		return
	}

	// Send initial event
	sendSSE(w, flusher, "status", `{"step":"starting","message":"Starting panel update..."}`)

	// Run update script
	scriptPath := h.cfg.ScriptsDir + "/update_panel.sh"
	cmd := exec.Command("/bin/bash", scriptPath)
	cmd.Dir = panelDir
	cmd.Env = []string{
		"PATH=/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"GOPATH=/root/go",
		"PANEL_DIR=" + panelDir,
	}

	// Pipe stdout + stderr together
	cmd.Stderr = cmd.Stdout
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		sendSSE(w, flusher, "error", `{"message":"Failed to create output pipe"}`)
		return
	}

	if err := cmd.Start(); err != nil {
		sendSSE(w, flusher, "error", fmt.Sprintf(`{"message":"Failed to start update: %s"}`, err.Error()))
		return
	}

	log.Println("Panel update started")

	// Stream output line by line
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		data, _ := json.Marshal(map[string]string{"line": line})
		sendSSE(w, flusher, "log", string(data))
	}

	// Wait for process to finish
	err = cmd.Wait()
	if err != nil {
		data, _ := json.Marshal(map[string]string{"message": "Update failed: " + err.Error()})
		sendSSE(w, flusher, "error", string(data))
		log.Printf("Panel update failed: %v", err)
	} else {
		sendSSE(w, flusher, "complete", `{"message":"Update completed successfully! Your apps were not affected."}`)
		log.Println("Panel update completed successfully")
	}
}

// Log handles GET /api/update/log
// Returns the last update log contents
func (h *UpdateHandler) Log(w http.ResponseWriter, r *http.Request) {
	content, err := os.ReadFile(updateLogFile)
	if err != nil {
		if os.IsNotExist(err) {
			Success(w, map[string]string{"log": "No update log found."})
			return
		}
		Error(w, http.StatusInternalServerError, "Failed to read update log")
		return
	}

	// Return last 200 lines max
	lines := strings.Split(string(content), "\n")
	if len(lines) > 200 {
		lines = lines[len(lines)-200:]
	}

	Success(w, map[string]string{"log": strings.Join(lines, "\n")})
}

// sendSSE sends a Server-Sent Event
func sendSSE(w http.ResponseWriter, flusher http.Flusher, event, data string) {
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
	flusher.Flush()
}

// countUserApps returns the number of running PM2 processes that are NOT panel-backend
func countUserApps() int {
	cmd := exec.Command("/usr/bin/pm2", "jlist")
	out, err := cmd.Output()
	if err != nil {
		return 0
	}

	var procs []struct {
		Name   string `json:"name"`
		PM2Env struct {
			Status string `json:"status"`
		} `json:"pm2_env"`
	}

	if err := json.Unmarshal(out, &procs); err != nil {
		return 0
	}

	count := 0
	for _, p := range procs {
		if p.Name != "panel-backend" && p.PM2Env.Status == "online" {
			count++
		}
	}
	return count
}
