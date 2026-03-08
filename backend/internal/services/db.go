package services

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB wraps a pgx connection pool
type DB struct {
	Pool *pgxpool.Pool
}

// NewDB creates a new database connection pool
func NewDB(databaseURL string) (*DB, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}

	config.MaxConns = 20
	config.MinConns = 2
	config.MaxConnIdleTime = 30 * time.Second
	config.MaxConnLifetime = 5 * time.Minute
	config.HealthCheckPeriod = 30 * time.Second

	// Set statement timeout via connection parameters
	config.ConnConfig.RuntimeParams["statement_timeout"] = "30000"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	// Test connection
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return &DB{Pool: pool}, nil
}

// migrations is an ordered list of schema migrations. Each migration runs once.
// To add a new migration, append to this slice with the next version number.
// NEVER modify or reorder existing migrations — only append new ones.
var migrations = []struct {
	version     int
	description string
	sql         string
}{
	{
		version:     1,
		description: "Initial schema: apps, managed_databases, audit_log",
		sql: `
			CREATE TABLE IF NOT EXISTS apps (
				id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				name        TEXT UNIQUE NOT NULL,
				repo_url    TEXT NOT NULL,
				branch      TEXT NOT NULL DEFAULT 'main',
				port        INTEGER UNIQUE NOT NULL,
				domain      TEXT,
				ssl_enabled BOOLEAN NOT NULL DEFAULT false,
				env_vars    JSONB NOT NULL DEFAULT '{}',
				created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);

			CREATE TABLE IF NOT EXISTS managed_databases (
				id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				name       TEXT UNIQUE NOT NULL,
				db_user    TEXT UNIQUE NOT NULL,
				password   TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);

			CREATE TABLE IF NOT EXISTS audit_log (
				id          BIGSERIAL PRIMARY KEY,
				username    TEXT NOT NULL,
				ip          TEXT NOT NULL,
				method      TEXT NOT NULL,
				path        TEXT NOT NULL,
				status_code INTEGER NOT NULL DEFAULT 0,
				duration_ms INTEGER NOT NULL DEFAULT 0,
				body        JSONB DEFAULT '{}',
				created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);

			CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
		`,
	},
	// To add a new migration, append here:
	// {
	//     version:     2,
	//     description: "Add new_column to apps",
	//     sql:         `ALTER TABLE apps ADD COLUMN IF NOT EXISTS new_column TEXT;`,
	// },
}

// InitSchema runs all pending migrations in order and performs cleanup.
func (db *DB) InitSchema(ctx context.Context) error {
	// Create migrations tracking table
	_, err := db.Pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version     INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	// Get current version
	var currentVersion int
	err = db.Pool.QueryRow(ctx,
		"SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&currentVersion)
	if err != nil {
		return fmt.Errorf("check migration version: %w", err)
	}

	// Run pending migrations
	applied := 0
	for _, m := range migrations {
		if m.version <= currentVersion {
			continue
		}

		log.Printf("Running migration %d: %s", m.version, m.description)

		if _, err := db.Pool.Exec(ctx, m.sql); err != nil {
			return fmt.Errorf("migration %d failed: %w", m.version, err)
		}

		if _, err := db.Pool.Exec(ctx,
			"INSERT INTO schema_migrations (version, description) VALUES ($1, $2)",
			m.version, m.description); err != nil {
			return fmt.Errorf("record migration %d: %w", m.version, err)
		}

		applied++
	}

	if applied > 0 {
		log.Printf("Applied %d migration(s), now at version %d", applied, migrations[len(migrations)-1].version)
	} else {
		log.Printf("Database schema up to date (version %d)", currentVersion)
	}

	// Periodic cleanup: remove old audit log entries (> 90 days)
	result, err := db.Pool.Exec(ctx, "DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'")
	if err == nil {
		if count := result.RowsAffected(); count > 0 {
			log.Printf("Cleaned up %d old audit log entries", count)
		}
	}

	return nil
}

// Query executes a query and returns rows
func (db *DB) Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	return db.Pool.Query(ctx, sql, args...)
}

// QueryRow executes a query expecting a single row
func (db *DB) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	return db.Pool.QueryRow(ctx, sql, args...)
}

// Exec executes a statement
func (db *DB) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	return db.Pool.Exec(ctx, sql, args...)
}

// CountDatabases returns the number of managed databases
func (db *DB) CountDatabases() int {
	var count int
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM managed_databases").Scan(&count)
	if err != nil {
		return 0
	}
	return count
}

// CountApps returns the number of deployed apps
func (db *DB) CountApps() int {
	var count int
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := db.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM apps").Scan(&count)
	if err != nil {
		return 0
	}
	return count
}

// Close closes the database pool
func (db *DB) Close() {
	db.Pool.Close()
}
