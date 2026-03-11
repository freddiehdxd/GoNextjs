package handlers

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"panel-backend/internal/config"
	"panel-backend/internal/middleware"
	"panel-backend/internal/services"
)

const (
	defaultLogLines = 200
	maxLogLines     = 1000
)

// LogsHandler handles log viewing routes
type LogsHandler struct {
	pm2      *services.PM2
	exec     *services.Executor
	cfg      *config.Config
	upgrader websocket.Upgrader
}

// NewLogsHandler creates a new logs handler
func NewLogsHandler(pm2 *services.PM2, exec *services.Executor, cfg *config.Config) *LogsHandler {
	return &LogsHandler{
		pm2:  pm2,
		exec: exec,
		cfg:  cfg,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if origin == "" {
					return true
				}
				return origin == cfg.PanelOrigin
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
		},
	}
}

// AppLogs handles GET /api/logs/app/:name
func (h *LogsHandler) AppLogs(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidateAppName(name) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}

	lines := parseLines(r)

	log, err := h.pm2.Logs(name, lines)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	Success(w, map[string]string{"log": log})
}

// AppLogFile handles GET /api/logs/app/:name/file?type=out|error&lines=N
// Reads PM2 log files directly from disk (no subprocess) for lightweight polling.
func (h *LogsHandler) AppLogFile(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !services.ValidateAppName(name) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}

	logType := r.URL.Query().Get("type")
	if logType != "error" {
		logType = "out"
	}

	lines := parseLines(r)

	// PM2 stores logs in ~/.pm2/logs/{name}-{out|error}.log
	pm2Home := os.Getenv("HOME")
	if pm2Home == "" {
		pm2Home = "/root"
	}
	logFile := filepath.Join(pm2Home, ".pm2", "logs", fmt.Sprintf("%s-%s.log", name, logType))

	// Check file exists
	if _, err := os.Stat(logFile); os.IsNotExist(err) {
		Success(w, map[string]string{
			"log":  "",
			"type": logType,
			"file": logFile,
		})
		return
	}

	result, err := h.exec.RunBin("tail", "-n", fmt.Sprintf("%d", lines), logFile)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to read log file")
		return
	}

	Success(w, map[string]interface{}{
		"log":  strings.TrimSpace(result.Stdout),
		"type": logType,
		"file": logFile,
	})
}

// NginxLogs handles GET /api/logs/nginx
func (h *LogsHandler) NginxLogs(w http.ResponseWriter, r *http.Request) {
	logType := r.URL.Query().Get("type")
	if logType == "" {
		logType = "access"
	}

	var logFile string
	switch logType {
	case "access":
		logFile = "/var/log/nginx/access.log"
	case "error":
		logFile = "/var/log/nginx/error.log"
	default:
		logFile = "/var/log/nginx/access.log"
		logType = "access"
	}

	lines := parseLines(r)

	result, err := h.exec.RunBin("tail", "-n", fmt.Sprintf("%d", lines), logFile)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to read logs")
		return
	}

	Success(w, map[string]string{
		"log":  result.Stdout,
		"type": logType,
	})
}

// StreamLogs handles GET /api/logs/app/:name/ws — WebSocket real-time log streaming
func (h *LogsHandler) StreamLogs(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("app")
	if name == "" || !services.ValidateAppName(name) {
		http.Error(w, "Invalid app name", http.StatusBadRequest)
		return
	}

	// Verify JWT from query param or cookie
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		if cookie, err := r.Cookie("panel_token"); err == nil {
			tokenStr = cookie.Value
		}
	}
	if tokenStr == "" || !middleware.ValidateToken(tokenStr, h.cfg.JWTSecret) {
		http.Error(w, "Not authenticated", http.StatusUnauthorized)
		return
	}

	logType := r.URL.Query().Get("type")
	if logType != "error" {
		logType = "out"
	}

	// Resolve log file path
	pm2Home := os.Getenv("HOME")
	if pm2Home == "" {
		pm2Home = "/root"
	}
	logFile := filepath.Join(pm2Home, ".pm2", "logs", fmt.Sprintf("%s-%s.log", name, logType))

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Send initial tail (last 100 lines)
	if data, err := tailFile(logFile, 100); err == nil && data != "" {
		conn.WriteMessage(websocket.TextMessage, []byte(data))
	}

	// Open file and seek to end, then stream new lines
	f, err := os.Open(logFile)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("[waiting for log file...]\n"))
		// Poll until file exists
		for i := 0; i < 60; i++ {
			time.Sleep(1 * time.Second)
			f, err = os.Open(logFile)
			if err == nil {
				break
			}
		}
		if f == nil {
			return
		}
	}
	defer f.Close()

	// Seek to end
	f.Seek(0, io.SeekEnd)

	// Read pump (handles close from client)
	closeCh := make(chan struct{})
	go func() {
		defer close(closeCh)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Tail loop — check for new data every 500ms
	reader := bufio.NewReader(f)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-closeCh:
			return
		case <-ticker.C:
			var lines []string
			for {
				line, err := reader.ReadString('\n')
				if line != "" {
					lines = append(lines, line)
				}
				if err != nil {
					break
				}
			}
			if len(lines) > 0 {
				msg := strings.Join(lines, "")
				if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
					return
				}
			}
		}
	}
}

// tailFile reads the last N lines from a file
func tailFile(path string, n int) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n"), nil
}

// parseLines parses the ?lines= query parameter
func parseLines(r *http.Request) int {
	linesStr := r.URL.Query().Get("lines")
	if linesStr == "" {
		return defaultLogLines
	}

	n, err := strconv.Atoi(linesStr)
	if err != nil || n <= 0 {
		return defaultLogLines
	}
	if n > maxLogLines {
		return maxLogLines
	}
	return n
}
