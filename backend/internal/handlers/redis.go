package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// RedisHandler handles Redis status and management routes
type RedisHandler struct {
	exec *services.Executor
}

// NewRedisHandler creates a new Redis handler
func NewRedisHandler(exec *services.Executor) *RedisHandler {
	return &RedisHandler{exec: exec}
}

// Status handles GET /api/redis
func (h *RedisHandler) Status(w http.ResponseWriter, r *http.Request) {
	result, err := h.exec.RunBin("systemctl", "is-active", "--quiet", "redis-server")
	if err != nil {
		// Not installed or error
		Success(w, models.RedisInfo{
			Installed:  false,
			Running:    false,
			Connection: nil,
		})
		return
	}

	running := result.Code == 0

	if running {
		Success(w, models.RedisInfo{
			Installed: true,
			Running:   true,
			Connection: models.RedisConnection{
				Host:   "127.0.0.1",
				Port:   6379,
				URL:    "redis://127.0.0.1:6379",
				EnvVar: "REDIS_URL=redis://127.0.0.1:6379",
			},
		})
	} else {
		Success(w, models.RedisInfo{
			Installed:  false,
			Running:    false,
			Connection: nil,
		})
	}
}

// Install handles POST /api/redis/install
func (h *RedisHandler) Install(w http.ResponseWriter, r *http.Request) {
	result, err := h.exec.RunScript("install_redis.sh")
	if err != nil {
		Error(w, http.StatusInternalServerError, "Install failed")
		return
	}

	if result.Code != 0 {
		msg := result.Stderr
		if msg == "" {
			msg = "Install failed"
		}
		Error(w, http.StatusInternalServerError, msg)
		return
	}

	Success(w, map[string]string{"message": "Redis installed and started"})
}

// FlushDB handles POST /api/redis/flush/{db} — flush a specific Redis database
func (h *RedisHandler) FlushDB(w http.ResponseWriter, r *http.Request) {
	dbParam := chi.URLParam(r, "db")
	dbNum, err := strconv.Atoi(dbParam)
	if err != nil || dbNum < 0 || dbNum > 15 {
		Error(w, http.StatusBadRequest, "Invalid database number (0-15)")
		return
	}

	result, execErr := h.exec.RunBin("redis-cli", "-n", strconv.Itoa(dbNum), "FLUSHDB")
	if execErr != nil || result.Code != 0 {
		Error(w, http.StatusInternalServerError, "Failed to flush database")
		return
	}

	Success(w, map[string]string{"message": fmt.Sprintf("db%d flushed", dbNum)})
}

// Stats handles GET /api/redis/stats — Redis monitoring dashboard
func (h *RedisHandler) Stats(w http.ResponseWriter, r *http.Request) {
	// Single redis-cli INFO call — takes ~0.1ms
	result, err := h.exec.RunBin("redis-cli", "INFO")
	if err != nil || result.Code != 0 {
		Error(w, http.StatusServiceUnavailable, "Redis not available")
		return
	}

	info := parseRedisInfo(result.Stdout)

	stats := models.RedisStats{
		Version:            info["redis_version"],
		Uptime:             parseInt64(info["uptime_in_seconds"]),
		ConnectedClients:   int(parseInt64(info["connected_clients"])),
		BlockedClients:     int(parseInt64(info["blocked_clients"])),
		UsedMemory:         parseInt64(info["used_memory"]),
		UsedMemoryHuman:    info["used_memory_human"],
		UsedMemoryPeak:     parseInt64(info["used_memory_peak"]),
		UsedMemoryPeakHuman: info["used_memory_peak_human"],
		MemFragRatio:       parseFloat64(info["mem_fragmentation_ratio"]),
		TotalConnsRecv:     parseInt64(info["total_connections_received"]),
		TotalCmdsProc:      parseInt64(info["total_commands_processed"]),
		OpsPerSec:          parseInt64(info["instantaneous_ops_per_sec"]),
		KeyspaceHits:       parseInt64(info["keyspace_hits"]),
		KeyspaceMisses:     parseInt64(info["keyspace_misses"]),
		EvictedKeys:        parseInt64(info["evicted_keys"]),
		RdbLastSave:        parseInt64(info["rdb_last_save_time"]),
		RdbChanges:         parseInt64(info["rdb_changes_since_last_save"]),
		Role:               info["role"],
	}

	// Uptime human readable
	secs := int(stats.Uptime)
	days := secs / 86400
	hours := (secs % 86400) / 3600
	mins := (secs % 3600) / 60
	if days > 0 {
		stats.UptimeHuman = fmt.Sprintf("%dd %dh %dm", days, hours, mins)
	} else if hours > 0 {
		stats.UptimeHuman = fmt.Sprintf("%dh %dm", hours, mins)
	} else {
		stats.UptimeHuman = fmt.Sprintf("%dm", mins)
	}

	// Hit rate
	totalHits := stats.KeyspaceHits + stats.KeyspaceMisses
	if totalHits > 0 {
		stats.HitRate = float64(int(float64(stats.KeyspaceHits)/float64(totalHits)*10000)) / 100
	}

	// Parse keyspace lines: db0:keys=123,expires=45,avg_ttl=6789
	stats.Keyspaces = []models.RedisKeyspace{}
	for key, val := range info {
		if !strings.HasPrefix(key, "db") {
			continue
		}
		// Check it's a db number
		if len(key) < 3 {
			continue
		}
		if _, err := strconv.Atoi(key[2:]); err != nil {
			continue
		}
		ks := models.RedisKeyspace{DB: key}
		for _, part := range strings.Split(val, ",") {
			kv := strings.SplitN(part, "=", 2)
			if len(kv) != 2 {
				continue
			}
			switch kv[0] {
			case "keys":
				ks.Keys = parseInt64(kv[1])
				stats.TotalKeys += ks.Keys
			case "expires":
				ks.Expires = parseInt64(kv[1])
				stats.ExpiringKeys += ks.Expires
			case "avg_ttl":
				ks.AvgTTL = parseInt64(kv[1])
			}
		}
		stats.Keyspaces = append(stats.Keyspaces, ks)
	}

	Success(w, stats)
}

// parseRedisInfo parses the redis INFO output into a key-value map
func parseRedisInfo(output string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			result[parts[0]] = strings.TrimSpace(parts[1])
		}
	}
	return result
}

func parseInt64(s string) int64 {
	v, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return v
}

func parseFloat64(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return float64(int(v*100)) / 100
}
