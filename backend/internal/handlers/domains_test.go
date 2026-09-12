package handlers

import "testing"

func TestNormalizeDomain(t *testing.T) {
	tests := map[string]string{
		"Example.COM":        "example.com",
		"  app.example.com ": "app.example.com",
		"already.lower":      "already.lower",
		"":                   "",
	}
	for in, want := range tests {
		if got := normalizeDomain(in); got != want {
			t.Errorf("normalizeDomain(%q) = %q, want %q", in, got, want)
		}
	}
}
