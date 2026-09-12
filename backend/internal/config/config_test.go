package config

import (
	"testing"
	"time"
)

func TestParseDeployTimeout(t *testing.T) {
	tests := map[string]time.Duration{
		"":    15 * time.Minute,
		"20m": 20 * time.Minute,
		"30s": 1 * time.Minute, // below minimum → clamped
		"bad": 15 * time.Minute,
	}
	for in, want := range tests {
		if got := parseDeployTimeout(in); got != want {
			t.Errorf("parseDeployTimeout(%q) = %v, want %v", in, got, want)
		}
	}
}
