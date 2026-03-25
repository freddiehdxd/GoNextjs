package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	cron "github.com/robfig/cron/v3"

	"panel-backend/internal/models"
)

const (
	cronWorkerPoolSize = 10
	cronMaxOutputBytes = 64 * 1024 // 64KB
	cronPoolSkipLimit  = 3         // consecutive pool-full skips before "missed"
	cronTickInterval   = 60 * time.Second
)

// ParseSchedule parses a 5-field cron expression using robfig/cron/v3.
// Returns the parsed schedule or an error if the expression is invalid.
func ParseSchedule(expr string) (cron.Schedule, error) {
	p := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	return p.Parse(expr)
}

// truncateOutput keeps the last cronMaxOutputBytes bytes of output.
// If truncated, a notice is prepended.
func truncateOutput(b []byte) []byte {
	if len(b) <= cronMaxOutputBytes {
		return b
	}
	tail := b[len(b)-cronMaxOutputBytes:]
	notice := []byte("[output truncated — showing last 64KB]\n")
	return append(notice, tail...)
}

// cronJob is a lightweight job record fetched by the scheduler.
type cronJob struct {
	ID        string
	AppID     *string
	AppName   string // resolved from DB join (empty if app_id IS NULL)
	RepoURL   string
	Branch    string
	Port      int
	MaxMemory int
	EnvVars   map[string]string
	Name      string
	Schedule  string
	Command   *string
	Action    *string
	MaxRuntime int
	NextRunAt time.Time
}

// CronScheduler runs cron jobs on a 60-second tick.
type CronScheduler struct {
	db      *DB
	pm2     *PM2
	exec    *Executor
	appsDir string

	mu        sync.Mutex
	inFlight  map[string]struct{} // job ID → in-flight sentinel
	skipCount map[string]int      // job ID → consecutive pool-full skip count
	pool      chan struct{}        // semaphore limiting concurrent workers

	cancel context.CancelFunc
}

// NewCronScheduler creates a scheduler. Call Start to begin ticking.
func NewCronScheduler(db *DB, pm2 *PM2, exec *Executor, appsDir string) *CronScheduler {
	return &CronScheduler{
		db:        db,
		pm2:       pm2,
		exec:      exec,
		appsDir:   appsDir,
		inFlight:  make(map[string]struct{}),
		skipCount: make(map[string]int),
		pool:      make(chan struct{}, cronWorkerPoolSize),
	}
}

// Start launches the scheduler goroutine. ctx is for the parent; the scheduler
// creates its own cancellable child context exposed via Stop.
func (s *CronScheduler) Start(ctx context.Context) {
	child, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	go s.run(child)
}

// Stop cancels the scheduler goroutine and stops accepting new work.
// Any in-flight runs will finish on their own or be cleaned up by
// cleanupOrphans on the next panel start.
func (s *CronScheduler) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
}

// IsRunning returns true if the given job ID has an active run.
func (s *CronScheduler) IsRunning(jobID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.inFlight[jobID]
	return ok
}

// RunNow dispatches a job immediately, ignoring its schedule.
// Returns error if the job is already running or does not exist.
// Note: RunNow bypasses the worker pool semaphore — on-demand runs are
// always allowed regardless of pool saturation, since they are explicitly
// triggered by the operator.
func (s *CronScheduler) RunNow(ctx context.Context, jobID string) error {
	if s.IsRunning(jobID) {
		return fmt.Errorf("job is already running")
	}

	job, err := s.fetchJob(ctx, jobID)
	if err != nil {
		return fmt.Errorf("fetch job: %w", err)
	}

	runID, err := s.insertRun(ctx, job)
	if err != nil {
		return fmt.Errorf("insert run: %w", err)
	}

	s.mu.Lock()
	s.inFlight[jobID] = struct{}{}
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.inFlight, jobID)
			s.mu.Unlock()
		}()
		s.executeJob(ctx, job, runID)
	}()

	return nil
}

func (s *CronScheduler) run(ctx context.Context) {
	s.cleanupOrphans(ctx)

	ticker := time.NewTicker(cronTickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

func (s *CronScheduler) tick(ctx context.Context) {
	rows, err := s.db.Query(ctx, `
        SELECT
            j.id, j.app_id,
            COALESCE(a.name,'')        AS app_name,
            COALESCE(a.repo_url,'')    AS repo_url,
            COALESCE(a.branch,'')      AS branch,
            COALESCE(a.port,0)         AS port,
            COALESCE(a.max_memory,512) AS max_memory,
            COALESCE(a.env_vars,'{}')  AS env_vars,
            j.name, j.schedule, j.command, j.action, j.max_runtime, j.next_run_at
        FROM cron_jobs j
        LEFT JOIN apps a ON a.id = j.app_id
        WHERE j.enabled = true AND j.next_run_at <= NOW()
    `)
	if err != nil {
		log.Printf("cron: query due jobs: %v", err)
		return
	}
	defer rows.Close()

	var jobs []cronJob
	for rows.Next() {
		var j cronJob
		var envJSON []byte
		if err := rows.Scan(
			&j.ID, &j.AppID,
			&j.AppName, &j.RepoURL, &j.Branch, &j.Port, &j.MaxMemory, &envJSON,
			&j.Name, &j.Schedule, &j.Command, &j.Action, &j.MaxRuntime, &j.NextRunAt,
		); err != nil {
			log.Printf("cron: scan job: %v", err)
			continue
		}
		j.EnvVars = make(map[string]string)
		if len(envJSON) > 0 {
			json.Unmarshal(envJSON, &j.EnvVars) // best-effort
		}
		jobs = append(jobs, j)
	}
	rows.Close()

	now := time.Now()
	for _, job := range jobs {
		// Missed run: next_run_at was >2 min ago — panel was down
		if job.NextRunAt.Before(now.Add(-2 * time.Minute)) {
			s.recordMissed(ctx, job)
			s.advanceSchedule(ctx, job)
			continue
		}

		// Skip if already in-flight
		s.mu.Lock()
		_, running := s.inFlight[job.ID]
		s.mu.Unlock()
		if running {
			continue
		}

		// Try to acquire pool slot
		select {
		case s.pool <- struct{}{}:
			s.mu.Lock()
			s.skipCount[job.ID] = 0
			s.inFlight[job.ID] = struct{}{}
			s.mu.Unlock()

			s.advanceSchedule(ctx, job)

			runID, err := s.insertRun(ctx, job)
			if err != nil {
				log.Printf("cron: insert run for job %s: %v", job.ID, err)
				<-s.pool
				s.mu.Lock()
				delete(s.inFlight, job.ID)
				s.mu.Unlock()
				continue
			}

			go func(j cronJob, rid int64) {
				defer func() {
					<-s.pool
					s.mu.Lock()
					delete(s.inFlight, j.ID)
					s.mu.Unlock()
				}()
				s.executeJob(ctx, j, rid)
			}(job, runID)

		default:
			// Pool full
			s.mu.Lock()
			s.skipCount[job.ID]++
			count := s.skipCount[job.ID]
			s.mu.Unlock()

			if count >= cronPoolSkipLimit {
				s.recordMissed(ctx, job)
				s.advanceSchedule(ctx, job)
				s.mu.Lock()
				s.skipCount[job.ID] = 0
				s.mu.Unlock()
			}
		}
	}
}

func (s *CronScheduler) executeJob(ctx context.Context, job cronJob, runID int64) {
	var output string
	var exitCode int
	status := "success"

	if job.Command != nil {
		output, exitCode = s.runCommand(ctx, job)
		if exitCode == 124 {
			status = "timeout"
		} else if exitCode != 0 {
			status = "error"
		}
	} else if job.Action != nil {
		output, exitCode = s.runAction(ctx, job)
		if exitCode != 0 {
			status = "error"
		}
	}

	finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.db.Exec(finishCtx,
		`UPDATE cron_runs SET status=$1, finished_at=NOW(), exit_code=$2, output=$3 WHERE id=$4`,
		status, exitCode, output, runID)

	// Prune runs > 100 for this job
	var count int
	s.db.QueryRow(finishCtx, `SELECT COUNT(*) FROM cron_runs WHERE job_id=$1`, job.ID).Scan(&count)
	if count > 100 {
		s.db.Exec(finishCtx,
			`DELETE FROM cron_runs WHERE job_id=$1 AND id NOT IN
             (SELECT id FROM cron_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 100)`,
			job.ID)
	}

	// Write audit log entry
	sc := 200
	if status != "success" {
		sc = 500
	}
	s.db.Exec(finishCtx,
		`INSERT INTO audit_log (username, ip, method, path, status_code, duration_ms, body)
         VALUES ('scheduler', '', 'CRON', $1, $2, 0, $3)`,
		fmt.Sprintf("/cron/jobs/%s", job.ID),
		sc,
		fmt.Sprintf(`{"job_id":"%s"}`, job.ID),
	)
}

func (s *CronScheduler) runCommand(ctx context.Context, job cronJob) (string, int) {
	timeout := time.Duration(job.MaxRuntime) * time.Second
	if job.MaxRuntime <= 0 {
		timeout = 24 * time.Hour // effectively unlimited
	}

	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, "/bin/sh", "-c", *job.Command)
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
	for k, v := range job.EnvVars {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	if job.AppName != "" {
		cmd.Dir = job.workDir(s.appsDir)
	} else {
		wd, _ := os.Getwd()
		cmd.Dir = wd
	}

	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	err := cmd.Run()
	out := string(truncateOutput(buf.Bytes()))

	if err != nil {
		if execCtx.Err() == context.DeadlineExceeded {
			return out + "\n[timed out]", 124
		}
		if exitErr, ok := err.(*exec.ExitError); ok {
			return out, exitErr.ExitCode()
		}
		return out + "\n" + err.Error(), 1
	}
	return out, 0
}

// workDir returns the working directory for a command job.
func (j cronJob) workDir(base string) string {
	if j.AppName == "" {
		return base
	}
	return base + "/" + j.AppName
}

func (s *CronScheduler) runAction(ctx context.Context, job cronJob) (string, int) {
	switch *job.Action {
	case "restart":
		result, err := s.pm2.Action("restart", job.AppName)
		if err != nil {
			return err.Error(), 1
		}
		return result.Stdout, 0

	case "deploy":
		app := &models.App{
			Name:      job.AppName,
			RepoURL:   job.RepoURL,
			Branch:    job.Branch,
			Port:      job.Port,
			MaxMemory: job.MaxMemory,
			EnvVars:   job.EnvVars,
		}
		result, err := DeployApp(app, s.exec, s.appsDir)
		if err != nil {
			return err.Error(), 1
		}
		out := result.Stdout
		if result.Stderr != "" {
			out += "\n" + result.Stderr
		}
		return out, result.Code

	default:
		return fmt.Sprintf("unknown action: %s", *job.Action), 1
	}
}

func (s *CronScheduler) cleanupOrphans(ctx context.Context) {
	// Timed-out runs (timeout_at is set and in the past)
	s.db.Exec(ctx,
		`UPDATE cron_runs SET status='timeout', finished_at=NOW()
         WHERE status='running' AND timeout_at IS NOT NULL AND timeout_at < NOW()`)
	// Other running rows — panel restarted mid-run
	s.db.Exec(ctx,
		`UPDATE cron_runs SET status='error', finished_at=NOW(), output='panel restarted mid-run'
         WHERE status='running'`)
}

func (s *CronScheduler) recordMissed(ctx context.Context, job cronJob) {
	s.db.Exec(ctx,
		`INSERT INTO cron_runs (job_id, started_at, finished_at, status, output)
         VALUES ($1, $2, NOW(), 'missed', 'skipped: panel was offline')`,
		job.ID, job.NextRunAt)
}

func (s *CronScheduler) advanceSchedule(ctx context.Context, job cronJob) {
	sched, err := ParseSchedule(job.Schedule)
	if err != nil {
		return
	}
	next := sched.Next(time.Now())
	s.db.Exec(ctx,
		`UPDATE cron_jobs SET last_run_at=NOW(), next_run_at=$1 WHERE id=$2`,
		next, job.ID)
}

func (s *CronScheduler) insertRun(ctx context.Context, job cronJob) (int64, error) {
	var id int64
	timeoutAt := (*time.Time)(nil)
	if job.MaxRuntime > 0 {
		t := time.Now().Add(time.Duration(job.MaxRuntime) * time.Second)
		timeoutAt = &t
	}
	err := s.db.QueryRow(ctx,
		`INSERT INTO cron_runs (job_id, timeout_at, status) VALUES ($1, $2, 'running') RETURNING id`,
		job.ID, timeoutAt).Scan(&id)
	return id, err
}

func (s *CronScheduler) fetchJob(ctx context.Context, jobID string) (cronJob, error) {
	var j cronJob
	var envJSON []byte
	err := s.db.QueryRow(ctx, `
        SELECT
            j.id, j.app_id,
            COALESCE(a.name,'')        AS app_name,
            COALESCE(a.repo_url,'')    AS repo_url,
            COALESCE(a.branch,'')      AS branch,
            COALESCE(a.port,0)         AS port,
            COALESCE(a.max_memory,512) AS max_memory,
            COALESCE(a.env_vars,'{}')  AS env_vars,
            j.name, j.schedule, j.command, j.action, j.max_runtime, j.next_run_at
        FROM cron_jobs j
        LEFT JOIN apps a ON a.id = j.app_id
        WHERE j.id=$1
    `, jobID).Scan(
		&j.ID, &j.AppID,
		&j.AppName, &j.RepoURL, &j.Branch, &j.Port, &j.MaxMemory, &envJSON,
		&j.Name, &j.Schedule, &j.Command, &j.Action, &j.MaxRuntime, &j.NextRunAt,
	)
	if err != nil {
		return j, err
	}
	j.EnvVars = make(map[string]string)
	if len(envJSON) > 0 {
		json.Unmarshal(envJSON, &j.EnvVars) // best-effort
	}
	return j, nil
}
