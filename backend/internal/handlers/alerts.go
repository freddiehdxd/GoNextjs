package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// AlertsHandler handles alert settings and sends notifications
type AlertsHandler struct {
	db  *services.DB
	pm2 *services.PM2

	mu          sync.RWMutex
	settings    *models.AlertSettings
	lastAlerts  map[string]time.Time // debounce: event key -> last sent
	prevAppStatus map[string]string  // track app status changes
}

// NewAlertsHandler creates a new alerts handler and starts the background checker
func NewAlertsHandler(db *services.DB, pm2 *services.PM2) *AlertsHandler {
	h := &AlertsHandler{
		db:            db,
		pm2:           pm2,
		lastAlerts:    make(map[string]time.Time),
		prevAppStatus: make(map[string]string),
	}

	// Load settings from DB
	h.loadSettings()

	// Start background health/alert checker
	go h.checkLoop()

	return h
}

func (h *AlertsHandler) loadSettings() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var s models.AlertSettings
	var eventsJSON []byte
	err := h.db.QueryRow(ctx,
		"SELECT id, enabled, webhook_url, events, disk_threshold, memory_threshold FROM alert_settings LIMIT 1",
	).Scan(&s.ID, &s.Enabled, &s.WebhookURL, &eventsJSON, &s.DiskThreshold, &s.MemoryThreshold)
	if err != nil {
		return
	}
	json.Unmarshal(eventsJSON, &s.Events)

	h.mu.Lock()
	h.settings = &s
	h.mu.Unlock()
}

// Get handles GET /api/alerts
func (h *AlertsHandler) Get(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	s := h.settings
	h.mu.RUnlock()

	if s == nil {
		Success(w, &models.AlertSettings{Events: []string{"app_crash", "disk_full", "high_memory"}})
		return
	}
	Success(w, s)
}

// Update handles PUT /api/alerts
func (h *AlertsHandler) Update(w http.ResponseWriter, r *http.Request) {
	var body models.AlertSettings
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	eventsJSON, _ := json.Marshal(body.Events)

	ctx := r.Context()
	_, err := h.db.Exec(ctx,
		`UPDATE alert_settings SET enabled = $1, webhook_url = $2, events = $3,
		 disk_threshold = $4, memory_threshold = $5, updated_at = NOW()`,
		body.Enabled, body.WebhookURL, eventsJSON, body.DiskThreshold, body.MemoryThreshold)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to update settings")
		return
	}

	h.loadSettings()
	Success(w, body)
}

// TestAlert handles POST /api/alerts/test
func (h *AlertsHandler) TestAlert(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	s := h.settings
	h.mu.RUnlock()

	if s == nil || s.WebhookURL == "" {
		Error(w, http.StatusBadRequest, "No webhook URL configured")
		return
	}

	err := sendWebhook(s.WebhookURL, "test", "Test alert from ServerPanel", "This is a test notification to verify your webhook is working.")
	if err != nil {
		Error(w, http.StatusBadGateway, fmt.Sprintf("Webhook failed: %v", err))
		return
	}

	Success(w, map[string]string{"message": "Test alert sent"})
}

// checkLoop runs every 30 seconds to check system health and send alerts
func (h *AlertsHandler) checkLoop() {
	time.Sleep(10 * time.Second) // initial delay
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		h.mu.RLock()
		s := h.settings
		h.mu.RUnlock()

		if s == nil || !s.Enabled || s.WebhookURL == "" {
			continue
		}

		h.checkApps(s)
		h.checkDisk(s)
		h.checkMemory(s)
	}
}

func (h *AlertsHandler) checkApps(s *models.AlertSettings) {
	if !hasEvent(s.Events, "app_crash") {
		return
	}

	apps, err := h.pm2.List()
	if err != nil {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	for _, app := range apps {
		prevStatus := h.prevAppStatus[app.Name]
		h.prevAppStatus[app.Name] = app.Status

		// Alert on status change from online to stopped/errored
		if prevStatus == "online" && (app.Status == "stopped" || app.Status == "errored") {
			key := "app_crash:" + app.Name
			if h.shouldAlert(key, 5*time.Minute) {
				go sendWebhook(s.WebhookURL, "app_crash",
					fmt.Sprintf("App %s crashed", app.Name),
					fmt.Sprintf("Application **%s** changed status from `online` to `%s`.", app.Name, app.Status))
				h.lastAlerts[key] = time.Now()
			}
		}
	}
}

func (h *AlertsHandler) checkDisk(s *models.AlertSettings) {
	if !hasEvent(s.Events, "disk_full") {
		return
	}

	disk := readDisk()
	if disk.Total == 0 {
		return
	}

	if disk.Percent >= float64(s.DiskThreshold) {
		key := "disk_full"
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.shouldAlert(key, 30*time.Minute) {
			go sendWebhook(s.WebhookURL, "disk_full",
				fmt.Sprintf("Disk usage at %.0f%%", disk.Percent),
				fmt.Sprintf("Disk usage is **%.1f%%** (threshold: %d%%). Used: %s / %s.",
					disk.Percent, s.DiskThreshold, formatBytes(disk.Used), formatBytes(disk.Total)))
			h.lastAlerts[key] = time.Now()
		}
	}
}

func (h *AlertsHandler) checkMemory(s *models.AlertSettings) {
	if !hasEvent(s.Events, "high_memory") {
		return
	}

	mem := readMemory()
	if mem.Total == 0 {
		return
	}

	if mem.Percent >= float64(s.MemoryThreshold) {
		key := "high_memory"
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.shouldAlert(key, 10*time.Minute) {
			go sendWebhook(s.WebhookURL, "high_memory",
				fmt.Sprintf("Memory usage at %.0f%%", mem.Percent),
				fmt.Sprintf("Memory usage is **%.1f%%** (threshold: %d%%). Used: %s / %s.",
					mem.Percent, s.MemoryThreshold, formatBytes(mem.Used), formatBytes(mem.Total)))
			h.lastAlerts[key] = time.Now()
		}
	}
}

// shouldAlert returns true if enough time has passed since last alert for this key
// Must be called with h.mu held
func (h *AlertsHandler) shouldAlert(key string, cooldown time.Duration) bool {
	last, ok := h.lastAlerts[key]
	return !ok || time.Since(last) > cooldown
}

func hasEvent(events []string, event string) bool {
	for _, e := range events {
		if e == event {
			return true
		}
	}
	return false
}

// sendWebhook posts a notification to a webhook URL (Discord/Slack compatible)
func sendWebhook(url, eventType, title, description string) error {
	// Detect Discord webhook
	isDiscord := len(url) > 0 && (contains(url, "discord.com/api/webhooks") || contains(url, "discordapp.com/api/webhooks"))

	var payload []byte
	if isDiscord {
		// Discord embed format
		payload, _ = json.Marshal(map[string]interface{}{
			"embeds": []map[string]interface{}{
				{
					"title":       title,
					"description": description,
					"color":       webhookColor(eventType),
					"footer":      map[string]string{"text": "ServerPanel Alert"},
					"timestamp":   time.Now().UTC().Format(time.RFC3339),
				},
			},
		})
	} else {
		// Generic webhook (Slack-compatible)
		payload, _ = json.Marshal(map[string]interface{}{
			"event":       eventType,
			"title":       title,
			"description": description,
			"timestamp":   time.Now().UTC().Format(time.RFC3339),
		})
	}

	resp, err := http.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}

	log.Printf("[alert] Sent %s alert: %s", eventType, title)
	return nil
}

func webhookColor(eventType string) int {
	switch eventType {
	case "app_crash":
		return 0xFF4444 // red
	case "disk_full":
		return 0xFFAA00 // amber
	case "high_memory":
		return 0xFF8800 // orange
	case "health_check":
		return 0xFF6600 // red-orange
	case "test":
		return 0x8B5CF6 // violet
	default:
		return 0x888888
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// SendAlert is a public method that can be called from other handlers (e.g. health checker)
func (h *AlertsHandler) SendAlert(eventType, title, description string) {
	h.mu.RLock()
	s := h.settings
	h.mu.RUnlock()

	if s == nil || !s.Enabled || s.WebhookURL == "" {
		return
	}

	if !hasEvent(s.Events, eventType) && eventType != "health_check" {
		return
	}

	key := eventType + ":" + title
	h.mu.Lock()
	if !h.shouldAlert(key, 5*time.Minute) {
		h.mu.Unlock()
		return
	}
	h.lastAlerts[key] = time.Now()
	h.mu.Unlock()

	sendWebhook(s.WebhookURL, eventType, title, description)
}
