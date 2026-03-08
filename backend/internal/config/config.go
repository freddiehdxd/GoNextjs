package config

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Port          int
	JWTSecret     string
	DatabaseURL   string
	PanelOrigin   string
	AdminUsername  string
	AdminPassword string
	AdminPassHash string
	CookieSecure  bool
	AppsDir       string
	ScriptsDir    string
	NginxAvail    string
	NginxEnabled  string
	PortStart     int
	PortEnd       int
	DBHost        string
	Production    bool
}

func Load() (*Config, error) {
	// Load .env file if it exists (ignore error)
	_ = godotenv.Load()

	c := &Config{
		Port:          getEnvInt("PORT", 4000),
		JWTSecret:     getEnv("JWT_SECRET", ""),
		DatabaseURL:   getEnv("DATABASE_URL", ""),
		PanelOrigin:   getEnv("PANEL_ORIGIN", "http://localhost:3000"),
		AdminUsername:  getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: getEnv("ADMIN_PASSWORD", ""),
		AdminPassHash: getEnv("ADMIN_PASSWORD_HASH", ""),
		AppsDir:       getEnv("APPS_DIR", "/var/www/apps"),
		ScriptsDir:    getEnv("SCRIPTS_DIR", "/opt/panel/scripts"),
		NginxAvail:    getEnv("NGINX_AVAILABLE", "/etc/nginx/sites-available"),
		NginxEnabled:  getEnv("NGINX_ENABLED", "/etc/nginx/sites-enabled"),
		PortStart:     getEnvInt("APP_PORT_START", 3001),
		PortEnd:       getEnvInt("APP_PORT_END", 3999),
		DBHost:        getEnv("DB_HOST", "localhost"),
		Production:    getEnv("PANEL_ENV", getEnv("NODE_ENV", "production")) == "production",
	}

	// Determine cookie secure flag
	if getEnv("COOKIE_SECURE", "") == "true" || strings.HasPrefix(c.PanelOrigin, "https://") {
		c.CookieSecure = true
	}

	// Validate required fields
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	if c.Production {
		if c.JWTSecret == "" || c.JWTSecret == "dev-secret-change-me" {
			return nil, fmt.Errorf("JWT_SECRET must be set to a secure value in production")
		}
		if len(c.JWTSecret) < 32 {
			return nil, fmt.Errorf("JWT_SECRET must be at least 32 characters in production")
		}
		if c.AdminPassHash == "" {
			return nil, fmt.Errorf("ADMIN_PASSWORD_HASH is required in production (plaintext passwords are not allowed)")
		}
	} else {
		log.Println("WARNING: Running in development mode. Set PANEL_ENV=production for production use.")
	}

	if c.JWTSecret == "" {
		c.JWTSecret = "dev-secret-change-me"
	}

	return c, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
