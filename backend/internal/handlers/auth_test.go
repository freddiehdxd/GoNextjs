package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"panel-backend/internal/config"
	"panel-backend/internal/middleware"

	"github.com/golang-jwt/jwt/v5"
)

func newTestAuthHandler() *AuthHandler {
	cfg := &config.Config{
		AdminUsername: "admin",
		AdminPassword: "testpass123",
		AdminPassHash: "",
		JWTSecret:     "test-secret-key-that-is-long-enough",
		CookieSecure:  false,
		Production:    false,
	}
	return NewAuthHandler(cfg)
}

func TestLogin_Success(t *testing.T) {
	h := newTestAuthHandler()

	body := `{"username":"admin","password":"testpass123"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Check cookie is set
	cookies := w.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "panel_token" {
			found = true
			if !c.HttpOnly {
				t.Error("Cookie should be HttpOnly")
			}
			if c.Path != "/" {
				t.Errorf("Cookie path should be /, got %s", c.Path)
			}
		}
	}
	if !found {
		t.Error("Expected panel_token cookie to be set")
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	h := newTestAuthHandler()

	body := `{"username":"admin","password":"wrongpassword"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401, got %d", w.Code)
	}
}

func TestLogin_WrongUsername(t *testing.T) {
	h := newTestAuthHandler()

	body := `{"username":"notadmin","password":"testpass123"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401, got %d", w.Code)
	}
}

func TestLogin_EmptyFields(t *testing.T) {
	h := newTestAuthHandler()

	body := `{"username":"","password":""}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d", w.Code)
	}
}

func TestLogin_Lockout(t *testing.T) {
	h := newTestAuthHandler()

	// Fail 5 times to trigger lockout
	for i := 0; i < 5; i++ {
		body := `{"username":"admin","password":"wrong"}`
		req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Real-IP", "1.2.3.4")
		w := httptest.NewRecorder()
		h.Login(w, req)
	}

	// 6th attempt should be rate limited
	body := `{"username":"admin","password":"testpass123"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Real-IP", "1.2.3.4")
	w := httptest.NewRecorder()
	h.Login(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("Expected 429 (lockout), got %d", w.Code)
	}
}

func TestLogin_LockoutDifferentIP(t *testing.T) {
	h := newTestAuthHandler()

	// Fail 5 times from IP 1.2.3.4
	for i := 0; i < 5; i++ {
		body := `{"username":"admin","password":"wrong"}`
		req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Real-IP", "1.2.3.4")
		w := httptest.NewRecorder()
		h.Login(w, req)
	}

	// Attempt from different IP should NOT be locked out
	body := `{"username":"admin","password":"testpass123"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Real-IP", "5.6.7.8")
	w := httptest.NewRecorder()
	h.Login(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200 from different IP, got %d", w.Code)
	}
}

func TestLogout_ClearsCookie(t *testing.T) {
	h := newTestAuthHandler()

	req := httptest.NewRequest("POST", "/api/auth/logout", nil)
	w := httptest.NewRecorder()

	h.Logout(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	cookies := w.Result().Cookies()
	for _, c := range cookies {
		if c.Name == "panel_token" {
			if c.MaxAge != -1 {
				t.Error("Cookie MaxAge should be -1 to clear it")
			}
		}
	}
}

func TestMe_ValidToken(t *testing.T) {
	h := newTestAuthHandler()

	// Generate a valid token
	tokenStr, err := h.signToken("admin")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "panel_token", Value: tokenStr})
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Username string `json:"username"`
		} `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Data.Username != "admin" {
		t.Errorf("Expected username 'admin', got %q", resp.Data.Username)
	}
}

func TestMe_ExpiredToken(t *testing.T) {
	h := newTestAuthHandler()

	// Generate an expired token
	claims := middleware.JWTClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "admin",
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-3 * time.Hour)),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-1 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, _ := token.SignedString([]byte(h.cfg.JWTSecret))

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "panel_token", Value: tokenStr})
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 for expired token, got %d", w.Code)
	}
}

func TestMe_InvalidToken(t *testing.T) {
	h := newTestAuthHandler()

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "panel_token", Value: "invalid-garbage-token"})
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 for invalid token, got %d", w.Code)
	}
}

func TestMe_NoToken(t *testing.T) {
	h := newTestAuthHandler()

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 for no token, got %d", w.Code)
	}
}

func TestMe_WrongSecret(t *testing.T) {
	h := newTestAuthHandler()

	// Sign token with a different secret
	claims := middleware.JWTClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "admin",
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(2 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, _ := token.SignedString([]byte("wrong-secret-key"))

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "panel_token", Value: tokenStr})
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 for wrong secret, got %d", w.Code)
	}
}

func TestVerifyCredentials_ConstantTimeUsername(t *testing.T) {
	h := newTestAuthHandler()

	// Both should return false and take similar time
	// (We can't reliably test timing, but we verify behavior)
	if h.verifyCredentials("wrong-user", "wrong-pass") {
		t.Error("Should reject wrong username")
	}
	if h.verifyCredentials("admin", "wrong-pass") {
		t.Error("Should reject wrong password")
	}
	if !h.verifyCredentials("admin", "testpass123") {
		t.Error("Should accept correct credentials")
	}
}
