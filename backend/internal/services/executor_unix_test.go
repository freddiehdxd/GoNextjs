//go:build !windows

package services

import (
	"testing"
	"time"
)

// A timed-out script must not leave its children holding the stdout pipe:
// with process-group kill, run returns within a couple of seconds; without it
// cmd.Wait blocks until WaitDelay (10s) or the child exits (30s).
func TestRunKillsProcessGroup(t *testing.T) {
	e := NewExecutor(t.TempDir(), t.TempDir(), time.Minute)
	start := time.Now()
	res, err := e.run("/bin/bash", []string{"-c", "sleep 30 & wait"}, time.Second, runOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Code != timeoutCode {
		t.Errorf("code = %d, want %d", res.Code, timeoutCode)
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Errorf("run took %v; children were not killed with the process group", el)
	}
}
