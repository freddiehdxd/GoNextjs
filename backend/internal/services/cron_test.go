package services

import (
	"testing"
	"time"
)

func TestParseSchedule_ValidExpressions(t *testing.T) {
	cases := []string{
		"* * * * *",
		"0 * * * *",
		"0 0 * * *",
		"*/5 * * * *",
		"0 0 * * 0",
		"0 0 1 * *",
		"0 2 * * 1-5",
	}
	for _, expr := range cases {
		_, err := ParseSchedule(expr)
		if err != nil {
			t.Errorf("ParseSchedule(%q) should be valid, got error: %v", expr, err)
		}
	}
}

func TestParseSchedule_InvalidExpressions(t *testing.T) {
	cases := []string{
		"",
		"not a cron",
		"* * * *",
		"60 * * * *",
		"* 25 * * *",
	}
	for _, expr := range cases {
		_, err := ParseSchedule(expr)
		if err == nil {
			t.Errorf("ParseSchedule(%q) should be invalid, but got no error", expr)
		}
	}
}

func TestNextRunAfter_IsInFuture(t *testing.T) {
	sched, err := ParseSchedule("0 * * * *")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	next := sched.Next(now)
	if !next.After(now) {
		t.Errorf("Next run %v should be after now %v", next, now)
	}
}

func TestNextRunAfter_Hourly(t *testing.T) {
	sched, _ := ParseSchedule("0 * * * *")
	base := time.Date(2026, 1, 1, 10, 30, 0, 0, time.UTC)
	next := sched.Next(base)
	expected := time.Date(2026, 1, 1, 11, 0, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Errorf("Expected next hourly after 10:30 to be 11:00, got %v", next)
	}
}

func TestNextRunAfter_LeapYear(t *testing.T) {
	sched, err := ParseSchedule("0 0 29 2 *")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 2, 28, 12, 0, 0, 0, time.UTC)
	next := sched.Next(base)
	if next.Year() != 2028 || next.Month() != 2 || next.Day() != 29 {
		t.Errorf("Expected next Feb 29 to be 2028-02-29, got %v", next)
	}
}

func TestTruncateOutput_Under64KB(t *testing.T) {
	input := []byte("hello world")
	result := truncateOutput(input)
	if string(result) != "hello world" {
		t.Errorf("Under 64KB should be unchanged, got %q", result)
	}
}

func TestTruncateOutput_Over64KB(t *testing.T) {
	large := make([]byte, 100*1024)
	for i := range large {
		large[i] = 'x'
	}
	result := truncateOutput(large)
	if len(result) > cronMaxOutputBytes+100 {
		t.Errorf("Expected truncation to ~64KB, got %d bytes", len(result))
	}
	if string(result[:len("[output truncated")]) != "[output truncated" {
		t.Errorf("Expected truncation notice at start, got: %s", result[:50])
	}
}
