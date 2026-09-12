//go:build !windows

package services

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the child in its own process group and makes context
// cancellation kill the whole group, so npm/next/git grandchildren of a
// timed-out bash script do not survive as orphans holding the output pipes.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
