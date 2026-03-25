package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestCronHandler creates a handler with nil db/scheduler (sufficient for validation tests)
func newTestCronHandler() *CronHandler {
	return &CronHandler{db: nil, scheduler: nil}
}

func TestCronCreate_BothCommandAndAction(t *testing.T) {
	h := newTestCronHandler()
	body := `{"name":"test","schedule":"* * * * *","command":"echo hi","action":"restart"}`
	req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 when both command and action set, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCronCreate_NeitherCommandNorAction(t *testing.T) {
	h := newTestCronHandler()
	body := `{"name":"test","schedule":"* * * * *"}`
	req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 when neither command nor action set, got %d", w.Code)
	}
}

func TestCronCreate_InvalidAction(t *testing.T) {
	h := newTestCronHandler()
	body := `{"name":"test","schedule":"* * * * *","action":"explode"}`
	req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid action, got %d", w.Code)
	}
}

func TestCronCreate_InvalidSchedule(t *testing.T) {
	h := newTestCronHandler()
	body := `{"name":"test","schedule":"not a cron","command":"echo hi"}`
	req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid schedule, got %d", w.Code)
	}
}

func TestCronCreate_MissingName(t *testing.T) {
	h := newTestCronHandler()
	body := `{"schedule":"* * * * *","command":"echo hi"}`
	req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for missing name, got %d", w.Code)
	}
}

func TestCronCreate_NegativeMaxRuntime(t *testing.T) {
	h := newTestCronHandler()
	body := `{"name":"test","schedule":"* * * * *","command":"echo hi","max_runtime":-1}`
	req := httptest.NewRequest("POST", "/api/cron/jobs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for negative max_runtime, got %d", w.Code)
	}
}
