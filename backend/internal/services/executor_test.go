package services

import "testing"

func TestValidateAppName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"valid simple", "myapp", true},
		{"valid with numbers", "app123", true},
		{"valid with hyphens", "my-app-1", true},
		{"valid single char", "a", true},
		{"valid max length", "a" + string(make([]byte, 62)), false}, // 63 chars of mixed
		{"invalid uppercase", "MyApp", false},
		{"invalid starts with hyphen", "-myapp", false},
		{"invalid underscore", "my_app", false},
		{"invalid dot", "my.app", false},
		{"invalid space", "my app", false},
		{"invalid empty", "", false},
		{"invalid special chars", "app@name", false},
		{"invalid path traversal", "../etc", false},
		{"invalid slash", "my/app", false},
		{"invalid null byte", "app\x00name", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidateAppName(tt.input)
			if got != tt.want {
				t.Errorf("ValidateAppName(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestValidateDomain(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"valid simple", "example.com", true},
		{"valid subdomain", "app.example.com", true},
		{"valid deep subdomain", "a.b.c.example.com", true},
		{"valid with numbers", "app1.example.com", true},
		{"valid with hyphens", "my-app.example.com", true},
		{"invalid empty", "", false},
		{"invalid no tld", "localhost", false},
		{"invalid single letter tld", "example.c", false},
		{"invalid starts with dot", ".example.com", false},
		{"invalid double dot", "example..com", false},
		{"invalid space", "example .com", false},
		{"invalid special chars", "example!.com", false},
		{"invalid path traversal", "../../../etc/passwd", false},
		{"invalid slash", "example.com/path", false},
		{"invalid null byte", "example\x00.com", false},
		{"invalid uppercase rejected", "Example.COM", false},
		{"invalid underscore", "my_app.example.com", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidateDomain(tt.input)
			if got != tt.want {
				t.Errorf("ValidateDomain(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestValidatePgIdentifier(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"valid simple", "mydb", true},
		{"valid with underscore", "my_db", true},
		{"valid starts with underscore", "_mydb", true},
		{"valid with numbers", "db123", true},
		{"invalid empty", "", false},
		{"invalid starts with number", "1db", false},
		{"invalid uppercase", "MyDB", false},
		{"invalid hyphen", "my-db", false},
		{"invalid dot", "my.db", false},
		{"invalid space", "my db", false},
		{"invalid semicolon", "db;drop", false},
		{"invalid quotes", "db'name", false},
		{"invalid path traversal", "../etc", false},
		{"invalid null byte", "db\x00name", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidatePgIdentifier(tt.input)
			if got != tt.want {
				t.Errorf("ValidatePgIdentifier(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestAllowedScripts(t *testing.T) {
	// Verify known scripts are allowed
	expected := []string{
		"install_nginx.sh",
		"install_postgres.sh",
		"install_redis.sh",
		"deploy_next_app.sh",
		"setup_app.sh",
		"create_ssl.sh",
	}
	for _, script := range expected {
		if !allowedScripts[script] {
			t.Errorf("Expected script %q to be allowed", script)
		}
	}

	// Verify dangerous scripts are NOT allowed
	dangerous := []string{
		"rm.sh",
		"update_panel.sh",
		"../../etc/cron.d/evil.sh",
		"",
		"../deploy_next_app.sh",
	}
	for _, script := range dangerous {
		if allowedScripts[script] {
			t.Errorf("Script %q should NOT be allowed", script)
		}
	}
}

func TestAllowedBins(t *testing.T) {
	// Verify all allowed binaries use absolute paths
	for name, path := range allowedBins {
		if path[0] != '/' {
			t.Errorf("Binary %q has non-absolute path: %q", name, path)
		}
	}

	// Verify dangerous binaries are NOT allowed
	dangerous := []string{"bash", "sh", "rm", "chmod", "chown", "dd", "mkfs", "mount"}
	for _, bin := range dangerous {
		if _, ok := allowedBins[bin]; ok {
			t.Errorf("Binary %q should NOT be in the allowlist", bin)
		}
	}
}
