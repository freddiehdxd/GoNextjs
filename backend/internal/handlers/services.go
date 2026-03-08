package handlers

import (
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// knownServices defines the system services we expose for management.
var knownServices = []struct {
	Unit        string // systemd unit name
	DisplayName string
	Description string
	Icon        string // frontend icon hint
}{
	{"nginx", "NGINX", "Web server & reverse proxy", "globe"},
	{"redis-server", "Redis", "In-memory data store", "database"},
	{"postgresql", "PostgreSQL", "Relational database", "hard-drive"},
	{"pm2-root", "PM2", "Node.js process manager", "cpu"},
	{"ssh", "SSH", "Secure shell server", "terminal"},
	{"ufw", "UFW", "Firewall", "shield"},
	{"fail2ban", "Fail2Ban", "Intrusion prevention", "shield-alert"},
	{"cron", "Cron", "Task scheduler", "clock"},
}

type ServicesHandler struct {
	exec *services.Executor
}

func NewServicesHandler(exec *services.Executor) *ServicesHandler {
	return &ServicesHandler{exec: exec}
}

// List returns the status of all known services.
// GET /api/services
func (h *ServicesHandler) List(w http.ResponseWriter, r *http.Request) {
	out := make([]models.ServiceInfo, 0, len(knownServices))
	for _, svc := range knownServices {
		info := h.serviceStatus(svc.Unit)
		info.DisplayName = svc.DisplayName
		info.Description = svc.Description
		info.Icon = svc.Icon
		out = append(out, info)
	}
	Success(w, out)
}

// Restart restarts a known service.
// POST /api/services/{name}/restart
func (h *ServicesHandler) Restart(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !h.isKnown(name) {
		Error(w, 400, "Unknown service: "+name)
		return
	}

	res, err := h.exec.RunBin("systemctl", "restart", name)
	if err != nil {
		log.Printf("Failed to restart service %s: %v", name, err)
		Error(w, 500, "Failed to restart service")
		return
	}
	if res.Code != 0 {
		log.Printf("Restart failed for %s: %s", name, strings.TrimSpace(res.Stderr))
		Error(w, 500, "Failed to restart service")
		return
	}

	info := h.enrichInfo(name)
	Success(w, info)
}

// Stop stops a known service.
// POST /api/services/{name}/stop
func (h *ServicesHandler) Stop(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !h.isKnown(name) {
		Error(w, 400, "Unknown service: "+name)
		return
	}

	res, err := h.exec.RunBin("systemctl", "stop", name)
	if err != nil {
		log.Printf("Failed to stop service %s: %v", name, err)
		Error(w, 500, "Failed to stop service")
		return
	}
	if res.Code != 0 {
		log.Printf("Stop failed for %s: %s", name, strings.TrimSpace(res.Stderr))
		Error(w, 500, "Failed to stop service")
		return
	}

	info := h.enrichInfo(name)
	Success(w, info)
}

// Start starts a known service.
// POST /api/services/{name}/start
func (h *ServicesHandler) Start(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	if !h.isKnown(name) {
		Error(w, 400, "Unknown service: "+name)
		return
	}

	res, err := h.exec.RunBin("systemctl", "start", name)
	if err != nil {
		log.Printf("Failed to start service %s: %v", name, err)
		Error(w, 500, "Failed to start service")
		return
	}
	if res.Code != 0 {
		log.Printf("Start failed for %s: %s", name, strings.TrimSpace(res.Stderr))
		Error(w, 500, "Failed to start service")
		return
	}

	info := h.enrichInfo(name)
	Success(w, info)
}

func (h *ServicesHandler) enrichInfo(name string) models.ServiceInfo {
	info := h.serviceStatus(name)
	for _, svc := range knownServices {
		if svc.Unit == name {
			info.DisplayName = svc.DisplayName
			info.Description = svc.Description
			info.Icon = svc.Icon
			break
		}
	}
	return info
}

func (h *ServicesHandler) isKnown(name string) bool {
	for _, svc := range knownServices {
		if svc.Unit == name {
			return true
		}
	}
	return false
}

var memRegex = regexp.MustCompile(`Memory:\s*(.+)`)

func (h *ServicesHandler) serviceStatus(unit string) models.ServiceInfo {
	info := models.ServiceInfo{Name: unit}

	// Check if active
	res, err := h.exec.RunBin("systemctl", "is-active", unit)
	if err == nil {
		status := strings.TrimSpace(res.Stdout)
		info.Active = status == "active"
		info.Running = status == "active"
		info.StatusText = status
	}

	// Check if enabled
	res, err = h.exec.RunBin("systemctl", "is-enabled", unit)
	if err == nil {
		info.Enabled = strings.TrimSpace(res.Stdout) == "enabled"
	}

	// Get sub-state + PID + memory from systemctl show
	res, err = h.exec.RunBin("systemctl", "show", unit,
		"--property=SubState,MainPID,MemoryCurrent,ActiveEnterTimestamp")
	if err == nil {
		for _, line := range strings.Split(res.Stdout, "\n") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			key, val := parts[0], parts[1]
			switch key {
			case "SubState":
				info.SubState = val
			case "MainPID":
				if pid, e := strconv.Atoi(val); e == nil {
					info.MainPID = pid
				}
			case "MemoryCurrent":
				if val != "[not set]" && val != "" {
					if mem, e := strconv.ParseInt(val, 10, 64); e == nil {
						info.Memory = formatBytes(mem)
					}
				}
			}
		}
	}

	return info
}

func formatBytes(b int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
	)
	switch {
	case b >= GB:
		return strconv.FormatFloat(float64(b)/float64(GB), 'f', 1, 64) + " GB"
	case b >= MB:
		return strconv.FormatFloat(float64(b)/float64(MB), 'f', 1, 64) + " MB"
	case b >= KB:
		return strconv.FormatFloat(float64(b)/float64(KB), 'f', 1, 64) + " KB"
	default:
		return strconv.FormatInt(b, 10) + " B"
	}
}
