package handlers

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"panel-backend/internal/config"
	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

const (
	maxFileReadSize   = 1_000_000   // 1MB
	maxUploadSize     = 100 << 20   // 100MB
	maxFilenameLength = 255
)

var (
	blockedExtensions = map[string]bool{
		".exe": true, ".sh": true, ".bat": true, ".cmd": true,
		".ps1": true, ".dll": true, ".so": true,
	}
	filenameRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._\- ]*$`)
)

var errPathEscape = errors.New("path escapes app directory")

// resolveAppPath returns the cleaned absolute path of sub inside appDir, or
// errPathEscape if sub would leave appDir via "..", an absolute path, or a
// symlink. The deepest existing ancestor of the target is resolved with
// EvalSymlinks so a symlink planted inside the app directory cannot point
// outside it. appDir itself may not exist yet (uploads create it).
func resolveAppPath(appDir, sub string) (string, error) {
	base, err := filepath.Abs(appDir)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(sub) || strings.HasPrefix(sub, "/") || strings.HasPrefix(sub, `\`) {
		return "", errPathEscape
	}
	target := filepath.Clean(filepath.Join(base, sub))
	if !insideDir(base, target) {
		return "", errPathEscape
	}

	// Walk up to the deepest existing ancestor of target.
	existing := target
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		existing = parent
	}
	// Only check symlinks for the part at or below base; ancestors above
	// base are outside our control and irrelevant.
	if !insideDir(base, existing) {
		return target, nil
	}
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		resolvedBase = base // base does not exist yet
	}
	resolvedExisting, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	if !insideDir(resolvedBase, resolvedExisting) {
		return "", errPathEscape
	}
	return target, nil
}

// insideDir reports whether p equals dir or lies beneath it (both cleaned).
func insideDir(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// FilesHandler handles file browsing and editing routes
type FilesHandler struct {
	cfg *config.Config
}

// NewFilesHandler creates a new files handler
func NewFilesHandler(cfg *config.Config) *FilesHandler {
	return &FilesHandler{cfg: cfg}
}

// List handles GET /api/files/:app
func (h *FilesHandler) List(w http.ResponseWriter, r *http.Request) {
	appName := chi.URLParam(r, "app")
	if !services.ValidateAppName(appName) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}
	subPath := r.URL.Query().Get("path")

	appDir := filepath.Join(h.cfg.AppsDir, appName)
	resolved, err := resolveAppPath(appDir, subPath)
	if err != nil {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			Error(w, http.StatusNotFound, "Path not found")
		} else {
			Error(w, http.StatusInternalServerError, "Failed to read directory")
		}
		return
	}

	files := make([]models.FileEntry, 0, len(entries))
	for _, entry := range entries {
		entryType := "file"
		if entry.IsDir() {
			entryType = "dir"
		}
		entryPath := subPath
		if entryPath != "" {
			entryPath += "/"
		}
		entryPath += entry.Name()

		files = append(files, models.FileEntry{
			Name: entry.Name(),
			Type: entryType,
			Path: entryPath,
		})
	}

	// Sort: directories first, then files
	sort.Slice(files, func(i, j int) bool {
		if files[i].Type != files[j].Type {
			return files[i].Type == "dir"
		}
		return files[i].Name < files[j].Name
	})

	Success(w, files)
}

// GetContent handles GET /api/files/:app/content
func (h *FilesHandler) GetContent(w http.ResponseWriter, r *http.Request) {
	appName := chi.URLParam(r, "app")
	if !services.ValidateAppName(appName) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}
	subPath := r.URL.Query().Get("path")

	if subPath == "" {
		Error(w, http.StatusBadRequest, "path parameter required")
		return
	}

	appDir := filepath.Join(h.cfg.AppsDir, appName)
	resolved, err := resolveAppPath(appDir, subPath)
	if err != nil {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}

	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			Error(w, http.StatusNotFound, "File not found")
		} else {
			Error(w, http.StatusInternalServerError, "Failed to stat file")
		}
		return
	}

	if info.IsDir() {
		Error(w, http.StatusBadRequest, "Path is a directory")
		return
	}

	if info.Size() > maxFileReadSize {
		Error(w, http.StatusRequestEntityTooLarge, "File too large to edit inline (>1MB)")
		return
	}

	content, err := os.ReadFile(resolved)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Failed to read file")
		return
	}

	Success(w, map[string]string{"content": string(content)})
}

// SaveContent handles PUT /api/files/:app/content
func (h *FilesHandler) SaveContent(w http.ResponseWriter, r *http.Request) {
	appName := chi.URLParam(r, "app")
	if !services.ValidateAppName(appName) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}
	subPath := r.URL.Query().Get("path")

	if subPath == "" {
		Error(w, http.StatusBadRequest, "path parameter required")
		return
	}

	var body struct {
		Content string `json:"content"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "content string required")
		return
	}

	appDir := filepath.Join(h.cfg.AppsDir, appName)
	resolved, err := resolveAppPath(appDir, subPath)
	if err != nil {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}

	// Create parent directories
	if err := os.MkdirAll(filepath.Dir(resolved), 0755); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to create directories")
		return
	}

	if err := os.WriteFile(resolved, []byte(body.Content), 0644); err != nil {
		Error(w, http.StatusInternalServerError, "Failed to write file")
		return
	}

	Success(w, map[string]string{"message": "File saved"})
}

// Upload handles POST /api/files/:app/upload
func (h *FilesHandler) Upload(w http.ResponseWriter, r *http.Request) {
	appName := chi.URLParam(r, "app")
	if !services.ValidateAppName(appName) {
		Error(w, http.StatusBadRequest, "Invalid app name")
		return
	}
	subPath := r.URL.Query().Get("path")

	appDir := filepath.Join(h.cfg.AppsDir, appName)
	if _, err := resolveAppPath(appDir, subPath); err != nil {
		Error(w, http.StatusBadRequest, "Invalid path")
		return
	}

	// Parse multipart form (100MB max)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		Error(w, http.StatusBadRequest, "Failed to parse upload")
		return
	}

	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		Error(w, http.StatusBadRequest, "No files uploaded")
		return
	}

	uploaded := make([]string, 0, len(files))
	for _, fh := range files {
		// Sanitize filename
		name := sanitizeFilename(fh.Filename)
		if name == "" {
			continue
		}

		// Check blocked extensions
		ext := strings.ToLower(filepath.Ext(name))
		if blockedExtensions[ext] {
			continue
		}

		// Create destination
		destPath, err := resolveAppPath(appDir, filepath.Join(subPath, name))
		if err != nil {
			continue
		}

		// Open source file
		src, err := fh.Open()
		if err != nil {
			continue
		}
		os.MkdirAll(filepath.Dir(destPath), 0755)

		dst, err := os.Create(destPath)
		if err != nil {
			src.Close()
			continue
		}

		_, err = io.Copy(dst, src)
		src.Close()
		dst.Close()

		if err == nil {
			uploaded = append(uploaded, name)
		}
	}

	Success(w, map[string]interface{}{"uploaded": uploaded})
}

// sanitizeFilename cleans and validates a filename
func sanitizeFilename(name string) string {
	// Strip path components — basename only
	name = filepath.Base(name)

	// Remove null bytes and control characters
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 0x7f {
			return -1
		}
		return r
	}, name)

	// Reject dotfiles/hidden files outright
	if strings.HasPrefix(name, ".") {
		return ""
	}

	// Enforce max length
	if len(name) > maxFilenameLength {
		name = name[:maxFilenameLength]
	}

	// Validate pattern
	if name == "" || !filenameRegex.MatchString(name) {
		return ""
	}

	return name
}

// sanitizeFilename is used by Upload — exported for testing
func ValidateFilename(name string) string {
	return sanitizeFilename(name)
}

// formatSize formats bytes to human-readable string
func formatSize(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
