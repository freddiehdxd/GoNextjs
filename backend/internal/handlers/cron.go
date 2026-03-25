package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/services"
)

// CronHandler handles cron job CRUD and run management.
type CronHandler struct {
	db        *services.DB
	scheduler *services.CronScheduler
}

// NewCronHandler creates a CronHandler.
func NewCronHandler(db *services.DB, scheduler *services.CronScheduler) *CronHandler {
	return &CronHandler{db: db, scheduler: scheduler}
}

// cronJobRequest is the create/update payload.
type cronJobRequest struct {
	AppID      *string `json:"app_id"`
	Name       string  `json:"name"`
	Schedule   string  `json:"schedule"`
	Command    *string `json:"command"`
	Action     *string `json:"action"`
	MaxRuntime int     `json:"max_runtime"`
	Enabled    bool    `json:"enabled"`
}

// cronJobResponse is the API representation of a cron job.
type cronJobResponse struct {
	ID         string     `json:"id"`
	AppID      *string    `json:"app_id"`
	Name       string     `json:"name"`
	Schedule   string     `json:"schedule"`
	Command    *string    `json:"command"`
	Action     *string    `json:"action"`
	Enabled    bool       `json:"enabled"`
	MaxRuntime int        `json:"max_runtime"`
	LastRunAt  *time.Time `json:"last_run_at"`
	NextRunAt  time.Time  `json:"next_run_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

// cronRunResponse is the API representation of a cron run.
type cronRunResponse struct {
	ID         int64      `json:"id"`
	JobID      string     `json:"job_id"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	TimeoutAt  *time.Time `json:"timeout_at"`
	Status     string     `json:"status"`
	ExitCode   *int       `json:"exit_code"`
	Output     string     `json:"output"` // truncated preview; full via /output endpoint
}

func (h *CronHandler) validateRequest(body cronJobRequest) string {
	if body.Name == "" {
		return "name is required"
	}
	if body.Command == nil && body.Action == nil {
		return "exactly one of command or action must be set"
	}
	if body.Command != nil && body.Action != nil {
		return "exactly one of command or action must be set"
	}
	if body.Command != nil && *body.Command == "" {
		return "command must not be empty"
	}
	if body.Action != nil {
		if *body.Action != "restart" && *body.Action != "deploy" {
			return "action must be 'restart' or 'deploy'"
		}
	}
	if body.Schedule == "" {
		return "schedule is required"
	}
	if _, err := services.ParseSchedule(body.Schedule); err != nil {
		return fmt.Sprintf("invalid schedule: %v", err)
	}
	if body.MaxRuntime < 0 {
		return "max_runtime must be >= 0"
	}
	return ""
}

// List handles GET /api/cron/jobs
func (h *CronHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	appID := r.URL.Query().Get("app_id")

	query := `SELECT id, app_id, name, schedule, command, action, enabled, max_runtime,
                     last_run_at, next_run_at, created_at
              FROM cron_jobs ORDER BY created_at DESC`
	args := []interface{}{}
	if appID != "" {
		query = `SELECT id, app_id, name, schedule, command, action, enabled, max_runtime,
                        last_run_at, next_run_at, created_at
                 FROM cron_jobs WHERE app_id=$1 ORDER BY created_at DESC`
		args = append(args, appID)
	}

	rows, err := h.db.Query(ctx, query, args...)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch cron jobs")
		return
	}
	defer rows.Close()

	jobs := make([]cronJobResponse, 0)
	for rows.Next() {
		var j cronJobResponse
		if err := rows.Scan(&j.ID, &j.AppID, &j.Name, &j.Schedule, &j.Command, &j.Action,
			&j.Enabled, &j.MaxRuntime, &j.LastRunAt, &j.NextRunAt, &j.CreatedAt); err != nil {
			Error(w, http.StatusInternalServerError, "Failed to scan cron job")
			return
		}
		jobs = append(jobs, j)
	}
	Success(w, jobs)
}

// Create handles POST /api/cron/jobs
func (h *CronHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body cronJobRequest
	body.MaxRuntime = 300 // default
	body.Enabled = true
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if msg := h.validateRequest(body); msg != "" {
		Error(w, http.StatusBadRequest, msg)
		return
	}

	if h.db == nil {
		Error(w, http.StatusInternalServerError, "no database")
		return
	}

	sched, _ := services.ParseSchedule(body.Schedule)
	nextRun := sched.Next(time.Now())

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO cron_jobs (app_id, name, schedule, command, action, enabled, max_runtime, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		body.AppID, body.Name, body.Schedule, body.Command, body.Action,
		body.Enabled, body.MaxRuntime, nextRun,
	).Scan(&id)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to create cron job")
		return
	}

	SuccessCreated(w, map[string]string{"id": id})
}

// Get handles GET /api/cron/jobs/:id
func (h *CronHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var j cronJobResponse
	err := h.db.QueryRow(ctx,
		`SELECT id, app_id, name, schedule, command, action, enabled, max_runtime,
                last_run_at, next_run_at, created_at
         FROM cron_jobs WHERE id=$1`, id,
	).Scan(&j.ID, &j.AppID, &j.Name, &j.Schedule, &j.Command, &j.Action,
		&j.Enabled, &j.MaxRuntime, &j.LastRunAt, &j.NextRunAt, &j.CreatedAt)
	if err != nil {
		Error(w, http.StatusNotFound, "Cron job not found")
		return
	}
	Success(w, j)
}

// Update handles PUT /api/cron/jobs/:id
func (h *CronHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var body cronJobRequest
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if msg := h.validateRequest(body); msg != "" {
		Error(w, http.StatusBadRequest, msg)
		return
	}

	sched, _ := services.ParseSchedule(body.Schedule)
	nextRun := sched.Next(time.Now())

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	tag, err := h.db.Exec(ctx,
		`UPDATE cron_jobs SET name=$1, schedule=$2, command=$3, action=$4,
                              enabled=$5, max_runtime=$6, next_run_at=$7
         WHERE id=$8`,
		body.Name, body.Schedule, body.Command, body.Action,
		body.Enabled, body.MaxRuntime, nextRun, id)
	if err != nil || tag.RowsAffected() == 0 {
		Error(w, http.StatusNotFound, "Cron job not found")
		return
	}
	Success(w, map[string]string{"message": "updated"})
}

// Delete handles DELETE /api/cron/jobs/:id
func (h *CronHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	tag, err := h.db.Exec(ctx, `DELETE FROM cron_jobs WHERE id=$1`, id)
	if err != nil || tag.RowsAffected() == 0 {
		Error(w, http.StatusNotFound, "Cron job not found")
		return
	}
	Success(w, map[string]string{"message": "deleted"})
}

// Toggle handles POST /api/cron/jobs/:id/toggle
func (h *CronHandler) Toggle(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var enabled bool
	err := h.db.QueryRow(ctx,
		`UPDATE cron_jobs SET enabled = NOT enabled WHERE id=$1 RETURNING enabled`, id).Scan(&enabled)
	if err != nil {
		Error(w, http.StatusNotFound, "Cron job not found")
		return
	}
	Success(w, map[string]bool{"enabled": enabled})
}

// RunNow handles POST /api/cron/jobs/:id/run
func (h *CronHandler) RunNow(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	if h.scheduler == nil {
		Error(w, http.StatusInternalServerError, "no scheduler")
		return
	}

	if h.scheduler.IsRunning(id) {
		Error(w, http.StatusConflict, "job is already running")
		return
	}

	if err := h.scheduler.RunNow(r.Context(), id); err != nil {
		if errors.Is(err, services.ErrJobAlreadyRunning) {
			Error(w, http.StatusConflict, "job is already running")
			return
		}
		Error(w, http.StatusNotFound, "Cron job not found")
		return
	}
	Success(w, map[string]string{"message": "job dispatched"})
}

// Runs handles GET /api/cron/jobs/:id/runs
func (h *CronHandler) Runs(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := h.db.Query(ctx,
		`SELECT id, job_id, started_at, finished_at, timeout_at, status, exit_code,
                LEFT(output, 200) AS output_preview
         FROM cron_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 100`, id)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to fetch runs")
		return
	}
	defer rows.Close()

	runs := make([]cronRunResponse, 0)
	for rows.Next() {
		var run cronRunResponse
		if err := rows.Scan(&run.ID, &run.JobID, &run.StartedAt, &run.FinishedAt, &run.TimeoutAt,
			&run.Status, &run.ExitCode, &run.Output); err != nil {
			Error(w, http.StatusInternalServerError, "Failed to scan run")
			return
		}
		runs = append(runs, run)
	}
	Success(w, runs)
}

// RunOutput handles GET /api/cron/jobs/:id/runs/:run_id/output
func (h *CronHandler) RunOutput(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "run_id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var output string
	err := h.db.QueryRow(ctx, `SELECT output FROM cron_runs WHERE id=$1`, runID).Scan(&output)
	if err != nil {
		Error(w, http.StatusNotFound, "Run not found")
		return
	}
	Success(w, map[string]string{"output": output})
}
