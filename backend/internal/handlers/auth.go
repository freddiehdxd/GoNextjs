package handlers

import (
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"panel-backend/internal/config"
	"panel-backend/internal/middleware"
)

const (
	maxLoginAttempts = 5
	lockoutDuration  = 15 * time.Minute
	cleanupInterval  = 30 * time.Minute
	jwtExpiry        = 2 * time.Hour
	cookieName       = "panel_token"
	cookieMaxAge     = 2 * 60 * 60 // 2 hours in seconds
)

type loginAttempt struct {
	count      int
	lockedUntil time.Time
}

// AuthHandler handles authentication routes
type AuthHandler struct {
	cfg      *config.Config
	mu       sync.Mutex
	failures map[string]*loginAttempt
}

// NewAuthHandler creates a new auth handler
func NewAuthHandler(cfg *config.Config) *AuthHandler {
	h := &AuthHandler{
		cfg:      cfg,
		failures: make(map[string]*loginAttempt),
	}

	// Warn if using plaintext password fallback (dev mode only — production enforced in config)
	if cfg.AdminPassHash == "" && cfg.AdminPassword != "" {
		log.Println("WARNING: Using plaintext admin password. Set ADMIN_PASSWORD_HASH for production use.")
	}

	// Start cleanup goroutine — remove expired lockout entries to prevent memory leak
	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			h.mu.Lock()
			now := time.Now()
			for ip, a := range h.failures {
				// Delete entries where lockout has expired, or entries with no lockout and no recent attempts
				if (!a.lockedUntil.IsZero() && a.lockedUntil.Before(now)) || a.count == 0 {
					delete(h.failures, ip)
				}
			}
			h.mu.Unlock()
		}
	}()

	return h
}

// Login handles POST /api/auth/login
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := ReadJSON(r, &body); err != nil {
		Error(w, http.StatusBadRequest, "username and password required")
		return
	}

	if body.Username == "" || body.Password == "" {
		Error(w, http.StatusBadRequest, "username and password required")
		return
	}

	ip := extractIP(r)

	// Check lockout
	h.mu.Lock()
	attempt, exists := h.failures[ip]
	if exists && attempt.lockedUntil.After(time.Now()) {
		remaining := int(time.Until(attempt.lockedUntil).Minutes()) + 1
		h.mu.Unlock()
		Error(w, http.StatusTooManyRequests,
			fmt.Sprintf("Too many failed attempts. Try again in %d minute(s).", remaining))
		return
	}
	h.mu.Unlock()

	// Verify credentials
	if !h.verifyCredentials(body.Username, body.Password) {
		h.recordFailure(ip)
		Error(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	// Clear failures on success
	h.mu.Lock()
	delete(h.failures, ip)
	h.mu.Unlock()

	// Generate JWT
	tokenStr, err := h.signToken(body.Username)
	if err != nil {
		Error(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	// Set HttpOnly cookie
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    tokenStr,
		HttpOnly: true,
		Secure:   h.cfg.CookieSecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   cookieMaxAge,
		Path:     "/",
	})

	Success(w, map[string]string{"message": "Login successful"})
}

// Logout handles POST /api/auth/logout
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		HttpOnly: true,
		Secure:   h.cfg.CookieSecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
		Path:     "/",
	})

	Success(w, map[string]string{"message": "Logged out"})
}

// Me handles GET /api/auth/me
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	tokenStr := ""

	// Try cookie first
	if cookie, err := r.Cookie(cookieName); err == nil {
		tokenStr = cookie.Value
	}

	// Fall back to Authorization header
	if tokenStr == "" {
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			tokenStr = strings.TrimPrefix(auth, "Bearer ")
		}
	}

	if tokenStr == "" {
		Error(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	// Verify JWT
	token, err := jwt.ParseWithClaims(tokenStr, &middleware.JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return []byte(h.cfg.JWTSecret), nil
	})

	if err != nil || !token.Valid {
		// Clear invalid cookie
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    "",
			HttpOnly: true,
			Secure:   h.cfg.CookieSecure,
			SameSite: http.SameSiteStrictMode,
			MaxAge:   -1,
			Path:     "/",
		})
		Error(w, http.StatusUnauthorized, "Invalid or expired token")
		return
	}

	claims, ok := token.Claims.(*middleware.JWTClaims)
	if !ok {
		Error(w, http.StatusUnauthorized, "Invalid token claims")
		return
	}

	Success(w, map[string]string{"username": claims.Subject})
}

// verifyCredentials checks username/password against config
func (h *AuthHandler) verifyCredentials(username, password string) bool {
	// Constant-time username comparison to prevent timing attacks
	usernameMatch := subtle.ConstantTimeCompare([]byte(username), []byte(h.cfg.AdminUsername)) == 1

	if !usernameMatch {
		// Run bcrypt with a valid dummy hash to prevent timing-based user enumeration
		// This ensures failed-username and failed-password take similar time
		bcrypt.CompareHashAndPassword(
			[]byte("$2a$12$K4H7GhHqvHJYpjGKlBmr8OdX6B.lMFn3kLLhMzTnOE5j5L8Qz3cG6"),
			[]byte(password),
		)
		return false
	}

	// Prefer bcrypt hash (production enforces this via config validation)
	if h.cfg.AdminPassHash != "" {
		err := bcrypt.CompareHashAndPassword([]byte(h.cfg.AdminPassHash), []byte(password))
		return err == nil
	}

	// Fall back to plaintext with constant-time comparison (dev mode only)
	if h.cfg.AdminPassword == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(password), []byte(h.cfg.AdminPassword)) == 1
}

// signToken creates a JWT for the given username
func (h *AuthHandler) signToken(username string) (string, error) {
	now := time.Now()
	claims := middleware.JWTClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   username,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(jwtExpiry)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(h.cfg.JWTSecret))
}

// recordFailure increments failure count for an IP
func (h *AuthHandler) recordFailure(ip string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	attempt, exists := h.failures[ip]
	if !exists {
		attempt = &loginAttempt{}
		h.failures[ip] = attempt
	}

	attempt.count++
	if attempt.count >= maxLoginAttempts {
		attempt.lockedUntil = time.Now().Add(lockoutDuration)
	}
}

// extractIP gets client IP from request
func extractIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	addr := r.RemoteAddr
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		return addr[:idx]
	}
	return addr
}
