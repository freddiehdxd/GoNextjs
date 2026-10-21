package handlers

import (
	"testing"

	"panel-backend/internal/models"
)

func TestPm2ForDir(t *testing.T) {
	list := []models.Pm2Process{
		{Name: "shortsx", Status: "stopped"},
		{Name: "twistshow", Status: "stopped", Cwd: "/var/www/apps/shortsx/"},
	}
	m := pm2ForDir(list, "/var/www/apps/shortsx", "shortsx")
	if m == nil || m.name != "twistshow" {
		t.Fatalf("cwd match should win over name match, got %+v", m)
	}
	if m.port != 0 {
		t.Errorf("stopped process should report port 0, got %d", m.port)
	}

	m = pm2ForDir(list, "/var/www/apps/other", "shortsx")
	if m == nil || m.name != "shortsx" {
		t.Fatalf("name match should apply when no cwd matches, got %+v", m)
	}

	if m := pm2ForDir(list, "/var/www/apps/other", "other"); m != nil {
		t.Errorf("expected no match, got %+v", m)
	}
}
