package models

import "time"

// Domain represents a domain assigned to an app
type Domain struct {
	ID         string    `json:"id"`
	AppID      string    `json:"app_id"`
	Domain     string    `json:"domain"`
	SSLEnabled bool      `json:"ssl_enabled"`
	CreatedAt  time.Time `json:"created_at"`
}

// App represents a deployed application
type App struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	RepoURL       string            `json:"repo_url"`
	Branch        string            `json:"branch"`
	Port          int               `json:"port"`
	Domains       []Domain          `json:"domains"`
	EnvVars       map[string]string `json:"env_vars"`
	WebhookSecret string            `json:"webhook_secret,omitempty"`
	MaxMemory     int               `json:"max_memory"`
	MaxRestarts   int               `json:"max_restarts"`
	CreatedAt     time.Time         `json:"created_at"`
	UpdatedAt     time.Time         `json:"updated_at"`
	// Enriched fields from PM2 (not stored in DB)
	Status string  `json:"status,omitempty"`
	CPU    float64 `json:"cpu,omitempty"`
	Memory int64   `json:"memory,omitempty"`
}

// AlertSettings holds notification configuration
type AlertSettings struct {
	ID              string   `json:"id"`
	Enabled         bool     `json:"enabled"`
	WebhookURL      string   `json:"webhook_url"`
	Events          []string `json:"events"`
	DiskThreshold   int      `json:"disk_threshold"`
	MemoryThreshold int      `json:"memory_threshold"`
}

// BackupSettings holds backup configuration
type BackupSettings struct {
	ID         string `json:"id"`
	Enabled    bool   `json:"enabled"`
	Schedule   string `json:"schedule"`
	RetainDays int    `json:"retain_days"`
	BackupPath string `json:"backup_path"`
	S3Enabled  bool   `json:"s3_enabled"`
	S3Endpoint string `json:"s3_endpoint"`
	S3Bucket   string `json:"s3_bucket"`
	S3Key      string `json:"s3_key"`
	S3Secret   string `json:"s3_secret,omitempty"`
	S3Region   string `json:"s3_region"`
}

// BackupEntry holds a backup history record
type BackupEntry struct {
	ID         int64     `json:"id"`
	Type       string    `json:"type"`
	Filename   string    `json:"filename"`
	SizeBytes  int64     `json:"size_bytes"`
	DurationMs int       `json:"duration_ms"`
	Status     string    `json:"status"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// Database represents a managed PostgreSQL database
type Database struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	DBUser    string    `json:"db_user"`
	Password  string    `json:"-"` // never serialized
	CreatedAt time.Time `json:"created_at"`
}

// AuditEntry represents an audit log record
type AuditEntry struct {
	ID         int64     `json:"id"`
	Username   string    `json:"username"`
	IP         string    `json:"ip"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	StatusCode int       `json:"status_code"`
	DurationMs int       `json:"duration_ms"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

// Pm2Process represents a PM2 managed process
type Pm2Process struct {
	Name   string  `json:"name"`
	PmID   int     `json:"pm_id"`
	Status string  `json:"status"`
	CPU    float64 `json:"cpu"`
	Memory int64   `json:"memory"`
	Uptime int64   `json:"uptime"`
}

// Stats represents system statistics (current snapshot)
type Stats struct {
	CPU        CPUStats           `json:"cpu"`
	Memory     MemoryStats        `json:"memory"`
	Disk       DiskStats          `json:"disk"`
	Network    NetworkStats       `json:"network"`
	Networks   []NetworkInterface `json:"networks"`
	DiskIO     DiskIOStats        `json:"diskIO"`
	System     SystemStats        `json:"system"`
	Apps       AppsStats          `json:"apps"`
	Processes  []ProcessStats     `json:"processes"`
	DbTotal    int                `json:"dbTotal"`
	SiteTotal  int                `json:"siteTotal"`
}

// LiveStats is the full payload sent over WebSocket (current + history)
type LiveStats struct {
	Current *Stats       `json:"current"`
	History StatsHistory `json:"history"`
}

type CPUStats struct {
	Usage   float64   `json:"usage"`
	Cores   int       `json:"cores"`
	Model   string    `json:"model"`
	LoadAvg []float64 `json:"loadAvg"`
	PerCore []float64 `json:"perCore"`
	Times   CPUTimes  `json:"times"`
	Load    LoadInfo  `json:"load"`
}

type CPUTimes struct {
	User    float64 `json:"user"`
	Nice    float64 `json:"nice"`
	System  float64 `json:"system"`
	Idle    float64 `json:"idle"`
	IOWait  float64 `json:"iowait"`
	IRQ     float64 `json:"irq"`
	SoftIRQ float64 `json:"softirq"`
	Steal   float64 `json:"steal"`
}

type LoadInfo struct {
	One     float64 `json:"one"`
	Five    float64 `json:"five"`
	Fifteen float64 `json:"fifteen"`
	Max     int     `json:"max"`     // cores * 2
	Limit   int     `json:"limit"`   // cores
	Safe    int     `json:"safe"`    // cores * 75%
}

type MemoryStats struct {
	Total   int64   `json:"total"`
	Used    int64   `json:"used"`
	Free    int64   `json:"free"`
	Percent float64 `json:"percent"`
}

type DiskStats struct {
	Total   int64   `json:"total"`
	Used    int64   `json:"used"`
	Percent float64 `json:"percent"`
}

type NetworkStats struct {
	RxBytesPerSec int64  `json:"rxBytesPerSec"`
	TxBytesPerSec int64  `json:"txBytesPerSec"`
	RxTotal       int64  `json:"rxTotal"`
	TxTotal       int64  `json:"txTotal"`
	RxPackets     int64  `json:"rxPackets"`
	TxPackets     int64  `json:"txPackets"`
	Interface     string `json:"interface"`
}

type NetworkInterface struct {
	Name          string `json:"name"`
	RxBytesPerSec int64  `json:"rxBytesPerSec"`
	TxBytesPerSec int64  `json:"txBytesPerSec"`
	RxTotal       int64  `json:"rxTotal"`
	TxTotal       int64  `json:"txTotal"`
	RxPackets     int64  `json:"rxPackets"`
	TxPackets     int64  `json:"txPackets"`
}

type DiskIOStats struct {
	ReadBytesPerSec  int64  `json:"readBytesPerSec"`
	WriteBytesPerSec int64  `json:"writeBytesPerSec"`
	ReadTotal        int64  `json:"readTotal"`
	WriteTotal       int64  `json:"writeTotal"`
	Device           string `json:"device"`
}

type ProcessStats struct {
	PID     int     `json:"pid"`
	Name    string  `json:"name"`
	CPU     float64 `json:"cpu"`
	Memory  int64   `json:"memory"`
	MemPct  float64 `json:"memPct"`
	User    string  `json:"user"`
	Command string  `json:"command"`
}

type SystemStats struct {
	Uptime   string `json:"uptime"`
	Hostname string `json:"hostname"`
	Platform string `json:"platform"`
	Arch     string `json:"arch"`
}

type AppsStats struct {
	Total   int         `json:"total"`
	Running int         `json:"running"`
	Stopped int         `json:"stopped"`
	List    interface{} `json:"list"`
}

// StatsHistory holds ring buffer data points for sparkline charts
type StatsHistory struct {
	Timestamps []int64   `json:"timestamps"` // unix seconds
	CPU        []float64 `json:"cpu"`
	Memory     []float64 `json:"memory"`
	DiskRead   []int64   `json:"diskRead"`
	DiskWrite  []int64   `json:"diskWrite"`
	NetRx      []int64   `json:"netRx"`
	NetTx      []int64   `json:"netTx"`
}

// ---- PostgreSQL Monitoring ----

// PgOverview is the top-level response for GET /api/databases/stats
type PgOverview struct {
	Version     string       `json:"version"`
	Uptime      string       `json:"uptime"`
	MaxConns    int          `json:"maxConns"`
	ActiveConns int          `json:"activeConns"`
	IdleConns   int          `json:"idleConns"`
	TotalConns  int          `json:"totalConns"`
	CacheHit    float64      `json:"cacheHit"` // percentage
	TxCommit    int64        `json:"txCommit"`
	TxRollback  int64        `json:"txRollback"`
	TupFetched  int64        `json:"tupFetched"`
	TupInserted int64        `json:"tupInserted"`
	TupUpdated  int64        `json:"tupUpdated"`
	TupDeleted  int64        `json:"tupDeleted"`
	Conflicts   int64        `json:"conflicts"`
	Deadlocks   int64        `json:"deadlocks"`
	TempBytes   int64        `json:"tempBytes"`
	DbStats     []PgDbStats  `json:"databases"`
	SlowQueries []PgSlowQuery `json:"slowQueries"`
	Connections []PgConnInfo `json:"connections"`
}

// PgDbStats is per-database stats from pg_stat_database
type PgDbStats struct {
	Name        string  `json:"name"`
	Size        int64   `json:"size"` // bytes
	NumBackends int     `json:"numBackends"`
	TxCommit    int64   `json:"txCommit"`
	TxRollback  int64   `json:"txRollback"`
	CacheHit    float64 `json:"cacheHit"`
	TupFetched  int64   `json:"tupFetched"`
	TupInserted int64   `json:"tupInserted"`
	TupUpdated  int64   `json:"tupUpdated"`
	TupDeleted  int64   `json:"tupDeleted"`
}

// PgSlowQuery represents a currently active query from pg_stat_activity
type PgSlowQuery struct {
	PID       int     `json:"pid"`
	Database  string  `json:"database"`
	User      string  `json:"user"`
	Duration  float64 `json:"duration"` // seconds
	State     string  `json:"state"`
	Query     string  `json:"query"`
	WaitEvent string  `json:"waitEvent"`
}

// PgConnInfo shows connection breakdown per state
type PgConnInfo struct {
	State string `json:"state"`
	Count int    `json:"count"`
}

// ---- Redis Monitoring ----

// RedisStats is the response for GET /api/redis/stats
type RedisStats struct {
	Version        string  `json:"version"`
	Uptime         int64   `json:"uptime"` // seconds
	UptimeHuman    string  `json:"uptimeHuman"`
	ConnectedClients int   `json:"connectedClients"`
	BlockedClients int     `json:"blockedClients"`
	UsedMemory     int64   `json:"usedMemory"`
	UsedMemoryHuman string `json:"usedMemoryHuman"`
	UsedMemoryPeak int64   `json:"usedMemoryPeak"`
	UsedMemoryPeakHuman string `json:"usedMemoryPeakHuman"`
	MemFragRatio   float64 `json:"memFragRatio"`
	TotalConnsRecv int64   `json:"totalConnsRecv"`
	TotalCmdsProc  int64   `json:"totalCmdsProc"`
	OpsPerSec      int64   `json:"opsPerSec"`
	KeyspaceHits   int64   `json:"keyspaceHits"`
	KeyspaceMisses int64   `json:"keyspaceMisses"`
	HitRate        float64 `json:"hitRate"` // percentage
	TotalKeys      int64   `json:"totalKeys"`
	ExpiringKeys   int64   `json:"expiringKeys"`
	EvictedKeys    int64   `json:"evictedKeys"`
	RdbLastSave    int64   `json:"rdbLastSave"` // unix timestamp
	RdbChanges     int64   `json:"rdbChanges"`
	Role           string  `json:"role"` // master/slave
	Keyspaces      []RedisKeyspace `json:"keyspaces"`
}

// RedisKeyspace represents a single Redis DB keyspace
type RedisKeyspace struct {
	DB      string `json:"db"`
	Keys    int64  `json:"keys"`
	Expires int64  `json:"expires"`
	AvgTTL  int64  `json:"avgTtl"`
}

// ServiceInfo represents a system service status
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
	Running     bool   `json:"running"`
	Enabled     bool   `json:"enabled"`
	StatusText  string `json:"statusText"`
	SubState    string `json:"subState"`
	MainPID     int    `json:"mainPid"`
	Memory      string `json:"memory"`
	Uptime      string `json:"uptime"`
	Icon        string `json:"icon"`
}

// ExecResult holds the result of a command execution
type ExecResult struct {
	Stdout string
	Stderr string
	Code   int
}

// ApiResponse is the standard JSON envelope
type ApiResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// FileEntry represents a file/directory listing item
type FileEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // "file" or "dir"
	Path string `json:"path"`
}

// RedisInfo represents Redis status
type RedisInfo struct {
	Installed  bool        `json:"installed"`
	Running    bool        `json:"running"`
	Connection interface{} `json:"connection"`
}

type RedisConnection struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	URL    string `json:"url"`
	EnvVar string `json:"env_var"`
}
