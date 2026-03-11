package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"panel-backend/internal/services"
)

// HealthChecker performs periodic HTTP health checks on deployed apps
type HealthChecker struct {
	db  *services.DB
	pm2 *services.PM2

	mu      sync.RWMutex
	results map[string]*HealthResult // appName -> result
	alertFn func(eventType, title, desc string) // callback to send alerts
}

// HealthResult represents the health status of an app
type HealthResult struct {
	AppName       string    `json:"app_name"`
	Healthy       bool      `json:"healthy"`
	StatusCode    int       `json:"status_code"`
	ResponseMs    int       `json:"response_ms"`
	LastCheck     time.Time `json:"last_check"`
	FailCount     int       `json:"fail_count"`
	Error         string    `json:"error,omitempty"`
}

// NewHealthChecker creates a new health checker that runs every 60 seconds
func NewHealthChecker(db *services.DB, pm2 *services.PM2, alertFn func(string, string, string)) *HealthChecker {
	h := &HealthChecker{
		db:      db,
		pm2:     pm2,
		results: make(map[string]*HealthResult),
		alertFn: alertFn,
	}
	go h.loop()
	return h
}

// GetResults returns all health check results
func (h *HealthChecker) GetResults(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	results := make([]*HealthResult, 0, len(h.results))
	for _, r := range h.results {
		results = append(results, r)
	}
	Success(w, results)
}

func (h *HealthChecker) loop() {
	time.Sleep(15 * time.Second) // initial delay
	h.checkAll()

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		h.checkAll()
	}
}

func (h *HealthChecker) checkAll() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Get all apps with their ports
	rows, err := h.db.Query(ctx, "SELECT name, port FROM apps")
	if err != nil {
		return
	}
	defer rows.Close()

	type appInfo struct {
		name string
		port int
	}
	var apps []appInfo
	for rows.Next() {
		var a appInfo
		rows.Scan(&a.name, &a.port)
		apps = append(apps, a)
	}

	// Get PM2 status to know which apps are supposed to be running
	pm2List, _ := h.pm2.List()
	pm2Status := make(map[string]string)
	for _, p := range pm2List {
		pm2Status[p.Name] = p.Status
	}

	// Check each running app
	for _, app := range apps {
		status := pm2Status[app.name]
		if status != "online" {
			// Not running, skip health check but record status
			h.mu.Lock()
			h.results[app.name] = &HealthResult{
				AppName:   app.name,
				Healthy:   false,
				LastCheck: time.Now(),
				Error:     "not running (PM2 status: " + status + ")",
			}
			h.mu.Unlock()
			continue
		}

		h.checkApp(app.name, app.port)
	}

	// Clean up results for apps that no longer exist
	h.mu.Lock()
	existsMap := make(map[string]bool)
	for _, a := range apps {
		existsMap[a.name] = true
	}
	for name := range h.results {
		if !existsMap[name] {
			delete(h.results, name)
		}
	}
	h.mu.Unlock()
}

func (h *HealthChecker) checkApp(name string, port int) {
	client := &http.Client{Timeout: 10 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)

	start := time.Now()
	resp, err := client.Get(url)
	elapsed := time.Since(start)

	h.mu.Lock()
	defer h.mu.Unlock()

	prev := h.results[name]
	result := &HealthResult{
		AppName:    name,
		ResponseMs: int(elapsed.Milliseconds()),
		LastCheck:  time.Now(),
	}

	if err != nil {
		result.Healthy = false
		result.Error = err.Error()
		if prev != nil {
			result.FailCount = prev.FailCount + 1
		} else {
			result.FailCount = 1
		}
	} else {
		resp.Body.Close()
		result.StatusCode = resp.StatusCode
		// Consider 2xx and 3xx as healthy
		if resp.StatusCode >= 200 && resp.StatusCode < 400 {
			result.Healthy = true
			result.FailCount = 0
		} else {
			result.Healthy = false
			result.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
			if prev != nil {
				result.FailCount = prev.FailCount + 1
			} else {
				result.FailCount = 1
			}
		}
	}

	h.results[name] = result

	// Send alert after 3 consecutive failures
	if result.FailCount == 3 && h.alertFn != nil {
		errMsg := result.Error
		if errMsg == "" {
			errMsg = fmt.Sprintf("HTTP %d", result.StatusCode)
		}
		log.Printf("[health] App %s is unhealthy: %s", name, errMsg)
		go h.alertFn("health_check",
			fmt.Sprintf("App %s health check failing", name),
			fmt.Sprintf("Application **%s** has failed health checks 3 times in a row.\nError: `%s`", name, errMsg))
	}
}

// GetAppHealth returns the health status for a specific app (used by other handlers)
func (h *HealthChecker) GetAppHealth(name string) *HealthResult {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.results[name]
}

// HealthStatus enriches an app list with health info  
func (h *HealthChecker) HealthMap() map[string]*HealthResult {
	h.mu.RLock()
	defer h.mu.RUnlock()
	m := make(map[string]*HealthResult, len(h.results))
	for k, v := range h.results {
		m[k] = v
	}
	return m
}
