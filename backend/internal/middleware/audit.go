package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"panel-backend/internal/services"
)

// sensitiveKeys are redacted from audit log body
var sensitiveKeys = map[string]bool{
	"password":         true,
	"token":            true,
	"secret":           true,
	"jwt":              true,
	"current_password": true,
	"new_password":     true,
}

// statusRecorder wraps ResponseWriter to capture status code.
// It implements Unwrap() so http.NewResponseController can find
// the underlying Flusher (required for SSE streaming).
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap returns the underlying ResponseWriter so that
// http.NewResponseController can locate the http.Flusher interface.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Audit middleware logs POST/PUT/DELETE/PATCH requests
func Audit(db *services.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			method := r.Method

			// Only audit mutating methods
			if method != "POST" && method != "PUT" && method != "DELETE" && method != "PATCH" {
				next.ServeHTTP(w, r)
				return
			}

			start := time.Now()

			// Read and restore body for auditing
			var bodyJSON string
			if r.Body != nil && r.Header.Get("Content-Type") == "application/json" {
				bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024)) // 1MB max
				r.Body.Close()
				if err == nil {
					r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
					bodyJSON = sanitizeBody(bodyBytes)
				} else {
					r.Body = io.NopCloser(bytes.NewReader(nil))
					bodyJSON = "{}"
				}
			} else {
				bodyJSON = "{}"
			}

			// Wrap response writer to capture status code
			rec := &statusRecorder{ResponseWriter: w, statusCode: 200}

			next.ServeHTTP(rec, r)

			// Fire-and-forget audit log
			durationMs := int(time.Since(start).Milliseconds())
			username := GetUsername(r)
			ip := extractIP(r)

			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()

				_, err := db.Exec(ctx,
					`INSERT INTO audit_log (username, ip, method, path, status_code, duration_ms, body)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					username, ip, method, r.URL.Path, rec.statusCode, durationMs, bodyJSON,
				)
				if err != nil {
					log.Printf("audit log error: %v", err)
				}
			}()
		})
	}
}

// sanitizeBody redacts sensitive fields from JSON body
func sanitizeBody(raw []byte) string {
	var obj map[string]interface{}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "{}"
	}

	for key := range obj {
		if sensitiveKeys[strings.ToLower(key)] {
			obj[key] = "[REDACTED]"
		}
	}

	sanitized, err := json.Marshal(obj)
	if err != nil {
		return "{}"
	}
	return string(sanitized)
}

// extractIP gets the client IP from headers or connection
func extractIP(r *http.Request) string {
	// X-Real-IP (set by NGINX)
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}

	// X-Forwarded-For (first entry)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}

	// RemoteAddr (strip port)
	addr := r.RemoteAddr
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		return addr[:idx]
	}
	return addr
}
