package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"panel-backend/internal/services"
)

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func hasString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestListUnmanagedDirs(t *testing.T) {
	root := t.TempDir()
	mkdir(t, filepath.Join(root, "alpha"))
	mkdir(t, filepath.Join(root, "beta"))
	mkdir(t, filepath.Join(root, "Bad_Name"))
	mkdir(t, filepath.Join(root, ".hidden"))
	writeFile(t, filepath.Join(root, "notes.txt"), "x")

	// Symlinked directory must be skipped (skip test if symlinks unsupported, e.g. Windows without privilege)
	linkTarget := t.TempDir()
	symlinkOK := os.Symlink(linkTarget, filepath.Join(root, "linked")) == nil

	got, err := listUnmanagedDirs(root, map[string]bool{"beta": true})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Bad_Name", "alpha"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if symlinkOK {
		for _, n := range got {
			if n == "linked" {
				t.Errorf("symlinked dir must be skipped")
			}
		}
	}
}

func TestListUnmanagedDirsMissingRoot(t *testing.T) {
	_, err := listUnmanagedDirs(filepath.Join(t.TempDir(), "nope"), nil)
	if err == nil {
		t.Error("expected error for missing apps dir")
	}
}

func TestDirSize(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), "12345")                     // 5
	writeFile(t, filepath.Join(root, "src", "b.txt"), "123")                // 3
	writeFile(t, filepath.Join(root, "node_modules", "x.js"), "xxxxxxxxxx") // excluded
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "xxxxxxxxxx")         // excluded
	writeFile(t, filepath.Join(root, "dist", "i.html"), "xxxxxxxxxx")       // excluded
	if got := dirSize(root); got != 8 {
		t.Errorf("dirSize = %d, want 8", got)
	}
	if got := dirSize(filepath.Join(root, "missing")); got != 0 {
		t.Errorf("dirSize(missing) = %d, want 0", got)
	}
}

func TestReadGitInfo(t *testing.T) {
	t.Run("branch and origin", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".git", "HEAD"), "ref: refs/heads/develop\n")
		writeFile(t, filepath.Join(dir, ".git", "config"), `[core]
	repositoryformatversion = 0
[remote "origin"]
	url = https://github.com/acme/site.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "develop"]
	remote = origin
`)
		got := readGitInfo(dir)
		if got == nil || got.RepoURL != "https://github.com/acme/site.git" || got.Branch != "develop" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("detached head, no origin", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
		writeFile(t, filepath.Join(dir, ".git", "config"), "[core]\n\tbare = false\n")
		got := readGitInfo(dir)
		if got == nil || got.RepoURL != "" || got.Branch != "" {
			t.Errorf("got %+v, want empty fields", got)
		}
	})
	t.Run("no .git", func(t *testing.T) {
		if got := readGitInfo(t.TempDir()); got != nil {
			t.Errorf("got %+v, want nil", got)
		}
	})
}

func TestParseEcosystemPort(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"env: {\n      NODE_ENV: 'production',\n      PORT:     '3004',\n    },", 3004},
		{`PORT: "3010"`, 3010},
		{"PORT: 3011,", 3011},
		{`'PORT': '3012',`, 3012},
		{"script: \"./node_modules/next/dist/bin/next\",\n      args: \"start -p 3018\",", 3018},
		{`args: 'start --port 3020'`, 3020},
		{`args: "--port=3021"`, 3021},
		{`args: "-c 'PORT=3022 node server.js'"`, 3022},
		{"env: { PORT: '3004' },\n args: 'start -p 3018'", 3004},
		{"env: { SMTP_PORT: '587' }", 0},
		{"name: 'x'", 0},
		{"", 0},
	}
	for _, tt := range tests {
		if got := parseEcosystemPort(tt.in); got != tt.want {
			t.Errorf("parseEcosystemPort(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestDetectPort(t *testing.T) {
	t.Run("ecosystem wins over env", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "ecosystem.config.js"), "module.exports={apps:[{env:{PORT:'3004'}}]}")
		writeFile(t, filepath.Join(dir, ".env"), "PORT=3999\n")
		if got := detectPort(dir); got != 3004 {
			t.Errorf("got %d, want 3004", got)
		}
	})
	t.Run("env fallback", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".env"), "FOO=bar\nPORT=\"3020\"\n")
		if got := detectPort(dir); got != 3020 {
			t.Errorf("got %d, want 3020", got)
		}
	})
	t.Run("start script fallback", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "package.json"), `{"scripts":{"start":"next start -p 3018"}}`)
		if got := detectPort(dir); got != 3018 {
			t.Errorf("got %d, want 3018", got)
		}
	})
	t.Run("nothing", func(t *testing.T) {
		if got := detectPort(t.TempDir()); got != 0 {
			t.Errorf("got %d, want 0", got)
		}
	})
}

func TestFindDomainsFor(t *testing.T) {
	avail := t.TempDir()
	appDir := filepath.Join(string(filepath.Separator)+"var", "www", "apps", "site")
	writeFile(t, filepath.Join(avail, "proxy.example.com"),
		"server {\n    location / {\n        proxy_pass http://127.0.0.1:3004;\n    }\n}\n")
	writeFile(t, filepath.Join(avail, "static.example.com"),
		"server {\n    root "+filepath.Join(appDir, "dist")+";\n}\n")
	writeFile(t, filepath.Join(avail, "exact.example.com"),
		"server {\n    root "+appDir+";\n}\n")
	writeFile(t, filepath.Join(avail, "other.example.com"),
		"server {\n    proxy_pass http://127.0.0.1:3005;\n    root /var/www/apps/site2/dist;\n}\n")
	mkdir(t, filepath.Join(avail, "subdir")) // directories are ignored

	got := findDomainsFor(avail, 3004, appDir)
	want := []string{"exact.example.com", "proxy.example.com", "static.example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}

	// port 0 must not match anything by port
	got = findDomainsFor(avail, 0, filepath.Join(appDir, "nomatch"))
	if len(got) != 0 {
		t.Errorf("got %v, want none", got)
	}

	// missing dir → empty, no panic
	if got := findDomainsFor(filepath.Join(avail, "missing"), 3004, appDir); len(got) != 0 {
		t.Errorf("got %v, want none", got)
	}

	// upstream include directives
	t.Run("upstream includes", func(t *testing.T) {
		incDir := t.TempDir()
		writeFile(t, filepath.Join(incDir, "upstream.example.com.conf"),
			"server 127.0.0.1:3004;\n")
		writeFile(t, filepath.Join(avail, "upstream.example.com"),
			"upstream site_upstream {\n    include "+filepath.Join(incDir, "upstream.example.com.conf")+";\n}\nserver {\n    location / { proxy_pass http://site_upstream; }\n}\n")

		// should match when include contains the port
		got := findDomainsFor(avail, 3004, appDir)
		want := []string{"exact.example.com", "proxy.example.com", "static.example.com", "upstream.example.com"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}

		// should not match different port
		got = findDomainsFor(avail, 3005, appDir)
		if hasString(got, "upstream.example.com") {
			t.Errorf("got %v, should not include upstream.example.com for port 3005", got)
		}

		// missing include path should not panic or match
		writeFile(t, filepath.Join(avail, "broken.example.com"),
			"upstream site_upstream {\n    include /nonexistent/path/upstream.conf;\n}\nserver {\n    location / { proxy_pass http://site_upstream; }\n}\n")
		got = findDomainsFor(avail, 3004, appDir)
		if hasString(got, "broken.example.com") {
			t.Errorf("got %v, should not match broken.example.com with missing include", got)
		}
	})
}

func TestChoosePort(t *testing.T) {
	used := map[int]bool{3001: true, 3002: true, 3004: true}
	tests := []struct {
		name      string
		requested int
		detected  int
		want      int
		wantErr   bool
	}{
		{"requested free", 3010, 0, 3010, false},
		{"requested taken", 3002, 0, 0, true},
		{"requested below range", 3000, 0, 0, true},
		{"requested above range", 4000, 0, 0, true},
		{"detected free", 0, 3007, 3007, false},
		{"detected taken falls back to first free", 0, 3004, 3003, false},
		{"detected out of range falls back", 0, 8080, 3003, false},
		{"nothing given", 0, 0, 3003, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := choosePort(tt.requested, tt.detected, used, 3001, 3999)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
	t.Run("range exhausted", func(t *testing.T) {
		if _, err := choosePort(0, 0, map[int]bool{3001: true, 3002: true}, 3001, 3002); err == nil {
			t.Error("expected error when no free port")
		}
	})
}

// TestScanRouteNotShadowed guards the route layout in main.go: /apps/scan must
// hit the scan handler, not /apps/{name}.
func TestScanRouteNotShadowed(t *testing.T) {
	r := chi.NewRouter()
	hit := ""
	r.Get("/apps/{name}", func(w http.ResponseWriter, r *http.Request) { hit = "app:" + chi.URLParam(r, "name") })
	r.Get("/apps/scan", func(w http.ResponseWriter, r *http.Request) { hit = "scan" })
	r.Delete("/apps/scan/{name}", func(w http.ResponseWriter, r *http.Request) { hit = "del:" + chi.URLParam(r, "name") })

	req := httptest.NewRequest("GET", "/apps/scan", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if hit != "scan" {
		t.Errorf("GET /apps/scan hit %q, want scan", hit)
	}
	req = httptest.NewRequest("GET", "/apps/myapp", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if hit != "app:myapp" {
		t.Errorf("GET /apps/myapp hit %q, want app:myapp", hit)
	}
	req = httptest.NewRequest("DELETE", "/apps/scan/old", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)
	if hit != "del:old" {
		t.Errorf("DELETE /apps/scan/old hit %q, want del:old", hit)
	}
}

func TestScanResultJSONShape(t *testing.T) {
	res := ScanResult{
		AppsDir:   "/var/www/apps",
		Unmanaged: []UnmanagedDir{},
		Orphaned:  []OrphanedApp{},
	}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"apps_dir":"/var/www/apps","unmanaged":[],"orphaned":[]}`
	if string(data) != want {
		t.Errorf("got %s\nwant %s", data, want)
	}
}

func TestResolveImportType(t *testing.T) {
	t.Run("explicit type and root skip detection", func(t *testing.T) {
		dir := t.TempDir() // no package.json at all
		typ, root, err := resolveImportType(dir, "node", "/api")
		if err != nil || typ != "node" || root != "/api" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("explicit type defaults root", func(t *testing.T) {
		typ, root, err := resolveImportType(t.TempDir(), "static", "")
		if err != nil || typ != "static" || root != "/" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("invalid type rejected", func(t *testing.T) {
		if _, _, err := resolveImportType(t.TempDir(), "php", ""); err == nil {
			t.Error("expected error")
		}
	})
	t.Run("auto detects vite", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "vite.config.ts"), "export default {}")
		writeFile(t, filepath.Join(dir, "package.json"), `{"devDependencies":{"vite":"^5"}}`)
		typ, root, err := resolveImportType(dir, "", "")
		if err != nil || typ != "vite" || root != "/" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("auto with root hint detects in subdir", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "web", "next.config.js"), "module.exports={}")
		typ, root, err := resolveImportType(dir, "", "/web")
		if err != nil || typ != "next" || root != "/web" {
			t.Errorf("got %q %q %v", typ, root, err)
		}
	})
	t.Run("auto ambiguous surfaces detection error", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "web", "package.json"), `{"scripts":{"build":"x"},"dependencies":{"next":"1"}}`)
		writeFile(t, filepath.Join(dir, "app", "package.json"), `{"scripts":{"build":"x"},"dependencies":{"next":"1"}}`)
		if _, _, err := resolveImportType(dir, "", ""); err == nil {
			t.Error("expected ambiguity error")
		}
	})
}

func TestWritePanelMeta(t *testing.T) {
	dir := t.TempDir()
	if err := writePanelMeta(dir, "vite", "/web"); err != nil {
		t.Fatal(err)
	}
	meta, err := services.ReadPanelMeta(dir)
	if err != nil || meta.AppType != "vite" || meta.RootDir != "/web" {
		t.Errorf("got %+v %v", meta, err)
	}
}

func TestResolveUnderAppsDir(t *testing.T) {
	appsDir := t.TempDir()
	good, err := resolveUnderAppsDir(appsDir, "myapp")
	if err != nil || good != filepath.Join(appsDir, "myapp") {
		t.Errorf("got %q %v", good, err)
	}
	for _, bad := range []string{"..", "../x", "", "."} {
		if _, err := resolveUnderAppsDir(appsDir, bad); err == nil {
			t.Errorf("name %q should be rejected", bad)
		}
	}
}

func TestValidateDirName(t *testing.T) {
	valid := []string{"myapp", "Bad_Name", "My App", ".hidden"}
	for _, name := range valid {
		if err := validateDirName(name); err != nil {
			t.Errorf("expected %q to be accepted, got error: %v", name, err)
		}
	}
	invalid := []string{"", ".", "..", "a/b", `a\b`, "a\x00b"}
	for _, name := range invalid {
		if err := validateDirName(name); err == nil {
			t.Errorf("expected %q to be rejected", name)
		}
	}
}

func TestDecodeDirName(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"old%23backup", "old#backup", false},
		{"a%20b", "a b", false},
		{"Bad_Name", "Bad_Name", false},
		{"a%2Fb", "", true}, // decodes to a/b, rejected by validateDirName
		{"%zz", "", true},   // invalid percent-encoding
		{"..", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := decodeDirName(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("decodeDirName(%q) err = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("decodeDirName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestIsUniqueViolation(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"unique violation", &pgconn.PgError{Code: "23505"}, true},
		{"foreign key violation", &pgconn.PgError{Code: "23503"}, false},
		{"generic error", errors.New("x"), false},
		{"nil", nil, false},
		{"wrapped unique violation", fmt.Errorf("w: %w", &pgconn.PgError{Code: "23505"}), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isUniqueViolation(tt.err); got != tt.want {
				t.Errorf("isUniqueViolation(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}
