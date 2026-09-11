package services

import (
	"context"
	"fmt"
)

// PortAllocator manages port allocation for apps
type PortAllocator struct {
	db        *DB
	portStart int
	portEnd   int
}

// NewPortAllocator creates a new port allocator
func NewPortAllocator(db *DB, portStart, portEnd int) *PortAllocator {
	return &PortAllocator{
		db:        db,
		portStart: portStart,
		portEnd:   portEnd,
	}
}

// UsedPorts returns the set of ports currently assigned to apps.
func (pa *PortAllocator) UsedPorts(ctx context.Context) (map[int]bool, error) {
	rows, err := pa.db.Query(ctx, "SELECT port FROM apps")
	if err != nil {
		return nil, fmt.Errorf("query ports: %w", err)
	}
	defer rows.Close()

	used := make(map[int]bool)
	for rows.Next() {
		var port int
		if err := rows.Scan(&port); err != nil {
			return nil, fmt.Errorf("scan port: %w", err)
		}
		used[port] = true
	}
	return used, nil
}

// Allocate finds and returns the next free port
func (pa *PortAllocator) Allocate(ctx context.Context) (int, error) {
	usedPorts, err := pa.UsedPorts(ctx)
	if err != nil {
		return 0, err
	}
	for port := pa.portStart; port <= pa.portEnd; port++ {
		if !usedPorts[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free ports available in range %d-%d", pa.portStart, pa.portEnd)
}
