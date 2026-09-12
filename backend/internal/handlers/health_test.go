package handlers

import "testing"

func TestClassifyApp(t *testing.T) {
	tests := []struct {
		name      string
		appType   string
		startCmd  string
		pm2Status string
		wantProbe bool
		wantOK    bool
		wantStat  bool
	}{
		{"next online is probed", "next", "", "online", true, false, false},
		{"node stopped is unhealthy, not probed", "node", "", "stopped", false, false, false},
		{"node unknown to pm2", "node", "", "", false, false, false},
		{"vite is static healthy", "vite", "", "", false, true, true},
		{"static is static healthy", "static", "", "", false, true, true},
		{"custom without start cmd is static", "custom", "", "", false, true, true},
		{"custom with start cmd online is probed", "custom", "node s.js", "online", true, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probe, res := classifyApp(tt.appType, tt.startCmd, tt.pm2Status)
			if probe != tt.wantProbe {
				t.Fatalf("probe = %v, want %v", probe, tt.wantProbe)
			}
			if probe {
				if res != nil {
					t.Errorf("expected nil result when probing")
				}
				return
			}
			if res == nil {
				t.Fatal("expected a result when not probing")
			}
			if res.Healthy != tt.wantOK || res.Static != tt.wantStat {
				t.Errorf("Healthy=%v Static=%v, want %v %v", res.Healthy, res.Static, tt.wantOK, tt.wantStat)
			}
			if !tt.wantOK && res.Error == "" {
				t.Errorf("unhealthy result must carry an error message")
			}
		})
	}
}
