package handlers

import "testing"

func TestValidateOutputDir(t *testing.T) {
	tests := []struct {
		in   string
		want bool // true = valid
	}{
		{"dist", true},
		{"build/out", true},
		{"public", true},
		{"..", false},
		{"../x", false},
		{"a/../b", false},
		{".", false},
		{"./", false},
		{"/", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			err := validateOutputDir(tt.in)
			if (err == nil) != tt.want {
				t.Errorf("validateOutputDir(%q) err=%v, want valid=%v", tt.in, err, tt.want)
			}
		})
	}
}
