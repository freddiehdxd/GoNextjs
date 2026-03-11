package handlers

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

// AuditHandler handles audit log viewing
type AuditHandler struct {
	db *services.DB
}

// NewAuditHandler creates a new audit handler
func NewAuditHandler(db *services.DB) *AuditHandler {
	return &AuditHandler{db: db}
}

// List handles GET /api/audit — returns paginated audit log entries
func (h *AuditHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Parse query params
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset := (page - 1) * limit

	method := r.URL.Query().Get("method")
	search := r.URL.Query().Get("search")

	// Count total
	var total int
	countQuery := "SELECT COUNT(*) FROM audit_log WHERE 1=1"
	countArgs := []interface{}{}
	argIdx := 1

	if method != "" {
		countQuery += " AND method = $" + strconv.Itoa(argIdx)
		countArgs = append(countArgs, method)
		argIdx++
	}
	if search != "" {
		countQuery += " AND (path ILIKE $" + strconv.Itoa(argIdx) + " OR username ILIKE $" + strconv.Itoa(argIdx) + ")"
		countArgs = append(countArgs, "%"+search+"%")
		argIdx++
	}

	h.db.QueryRow(ctx, countQuery, countArgs...).Scan(&total)

	// Fetch entries
	query := "SELECT id, username, ip, method, path, status_code, duration_ms, body, created_at FROM audit_log WHERE 1=1"
	args := []interface{}{}
	argIdx = 1

	if method != "" {
		query += " AND method = $" + strconv.Itoa(argIdx)
		args = append(args, method)
		argIdx++
	}
	if search != "" {
		query += " AND (path ILIKE $" + strconv.Itoa(argIdx) + " OR username ILIKE $" + strconv.Itoa(argIdx) + ")"
		args = append(args, "%"+search+"%")
		argIdx++
	}

	query += " ORDER BY created_at DESC LIMIT $" + strconv.Itoa(argIdx) + " OFFSET $" + strconv.Itoa(argIdx+1)
	args = append(args, limit, offset)

	rows, err := h.db.Query(ctx, query, args...)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch audit log")
		return
	}
	defer rows.Close()

	entries := make([]models.AuditEntry, 0)
	for rows.Next() {
		var e models.AuditEntry
		if err := rows.Scan(&e.ID, &e.Username, &e.IP, &e.Method, &e.Path,
			&e.StatusCode, &e.DurationMs, &e.Body, &e.CreatedAt); err != nil {
			continue
		}
		entries = append(entries, e)
	}

	Success(w, map[string]interface{}{
		"entries": entries,
		"total":   total,
		"page":    page,
		"limit":   limit,
	})
}
