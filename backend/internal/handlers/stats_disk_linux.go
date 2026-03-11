//go:build linux

package handlers

import (
	"syscall"

	"panel-backend/internal/models"
)

func readDisk() models.DiskStats {
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err != nil {
		return models.DiskStats{}
	}

	total := int64(stat.Blocks) * int64(stat.Bsize)
	free := int64(stat.Bavail) * int64(stat.Bsize)
	used := total - free

	var percent float64
	if total > 0 {
		percent = float64(used) / float64(total) * 100
	}

	return models.DiskStats{
		Total:   total,
		Used:    used,
		Percent: round2(percent),
	}
}
