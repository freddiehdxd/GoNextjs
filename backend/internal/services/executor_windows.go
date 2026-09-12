//go:build windows

package services

import "os/exec"

// setProcessGroup is a no-op on Windows (dev machine only; the panel runs on Linux).
func setProcessGroup(cmd *exec.Cmd) {}
