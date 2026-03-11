//go:build windows

package handlers

import (
	"panel-backend/internal/models"
	"syscall"
	"unsafe"
)

func readDisk() models.DiskStats {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")

	var freeBytesAvailable, totalBytes, totalFreeBytes int64
	root, _ := syscall.UTF16PtrFromString("C:\\")
	ret, _, _ := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(root)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFreeBytes)),
	)
	if ret == 0 {
		return models.DiskStats{}
	}

	used := totalBytes - totalFreeBytes
	var percent float64
	if totalBytes > 0 {
		percent = float64(used) / float64(totalBytes) * 100
	}

	return models.DiskStats{
		Total:   totalBytes,
		Used:    used,
		Percent: round2(percent),
	}
}
