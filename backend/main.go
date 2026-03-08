package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"

	"panel-backend/internal/config"
	"panel-backend/internal/handlers"
	"panel-backend/internal/middleware"
	"panel-backend/internal/services"
)

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Connect to database
	db, err := services.NewDB(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Initialize schema
	ctx := context.Background()
	if err := db.InitSchema(ctx); err != nil {
		log.Fatalf("Failed to initialize database schema: %v", err)
	}

	// Create services
	exec := services.NewExecutor(cfg.ScriptsDir, cfg.AppsDir)
	pm2 := services.NewPM2(exec)
	nginx := services.NewNginx(exec, cfg.NginxAvail, cfg.NginxEnabled)
	portAlloc := services.NewPortAllocator(db, cfg.PortStart, cfg.PortEnd)

	// Create handlers
	authHandler := handlers.NewAuthHandler(cfg)
	appsHandler := handlers.NewAppsHandler(db, pm2, exec, portAlloc, cfg)
	domainsHandler := handlers.NewDomainsHandler(db, nginx)
	sslHandler := handlers.NewSSLHandler(db, nginx, exec)
	dbHandler := handlers.NewDatabasesHandler(db, cfg, exec)
	redisHandler := handlers.NewRedisHandler(exec)
	filesHandler := handlers.NewFilesHandler(cfg)
	logsHandler := handlers.NewLogsHandler(pm2, exec)
	statsHandler := handlers.NewStatsHandler(pm2, cfg, db)
	updateHandler := handlers.NewUpdateHandler(cfg)
	servicesHandler := handlers.NewServicesHandler(exec)

	// Create router
	r := chi.NewRouter()

	// Global middleware (applied to all routes)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)

	// CORS
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{cfg.PanelOrigin},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// General API rate limit: 300 req / 60 sec
	r.Use(httprate.LimitByIP(300, 60*time.Second))

	// Health check (no auth)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		uptime := time.Since(startTime).Seconds()
		fmt.Fprintf(w, `{"ok":true,"uptime":%.0f}`, uptime)
	})

	// WebSocket for live stats (auth checked inside handler)
	r.Get("/api/stats/ws", statsHandler.WebSocket)

	// Auth routes (no auth middleware)
	r.Route("/api/auth", func(r chi.Router) {
		r.Use(chimw.Compress(5))
		// Login rate limit: 10 req / 15 min
		r.With(httprate.LimitByIP(10, 15*time.Minute)).Post("/login", authHandler.Login)
		r.Post("/logout", authHandler.Logout)
		r.Get("/me", authHandler.Me)
	})

	// Protected API routes
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.Auth(cfg.JWTSecret))
		r.Use(middleware.Audit(db))

		// Compressed JSON routes
		r.Group(func(r chi.Router) {
			r.Use(chimw.Compress(5))

			// Apps
			r.Get("/apps", appsHandler.List)
			r.Post("/apps", appsHandler.Create)
			r.Get("/apps/{name}", appsHandler.Get)
			r.Post("/apps/{name}/action", appsHandler.Action)
			r.Get("/apps/{name}/env-file", appsHandler.ReadEnvFiles)
			r.Put("/apps/{name}/env", appsHandler.UpdateEnv)
			r.Post("/apps/{name}/deploy-zip", appsHandler.UploadProject)

			// Domains
			r.Post("/domains", domainsHandler.Add)
			r.Delete("/domains/{domain}", domainsHandler.Remove)

			// SSL
			r.Post("/ssl", sslHandler.Enable)
			r.Post("/ssl/disable", sslHandler.Disable)

			// Databases
			r.Get("/databases", dbHandler.List)
			r.Post("/databases", dbHandler.Create)
			r.Delete("/databases/{name}", dbHandler.Delete)
			r.Get("/databases/stats", dbHandler.Stats)
			r.Post("/databases/{name}/restore", dbHandler.Restore)

			// Redis
			r.Get("/redis", redisHandler.Status)
			r.Post("/redis/install", redisHandler.Install)
			r.Get("/redis/stats", redisHandler.Stats)

			// System Services
			r.Get("/services", servicesHandler.List)
			r.Post("/services/{name}/restart", servicesHandler.Restart)
			r.Post("/services/{name}/stop", servicesHandler.Stop)
			r.Post("/services/{name}/start", servicesHandler.Start)

			// Files
			r.Get("/files/{app}", filesHandler.List)
			r.Get("/files/{app}/content", filesHandler.GetContent)
			r.Put("/files/{app}/content", filesHandler.SaveContent)
			r.Post("/files/{app}/upload", filesHandler.Upload)

			// Logs
			r.Get("/logs/app/{name}", logsHandler.AppLogs)
			r.Get("/logs/app/{name}/file", logsHandler.AppLogFile)
			r.Get("/logs/nginx", logsHandler.NginxLogs)

			// Stats
			r.Get("/stats", statsHandler.Get)

			// Panel Update (check + log are normal JSON)
			r.Get("/update/check", updateHandler.Check)
			r.Get("/update/log", updateHandler.Log)
		})

		// SSE / streaming / large upload endpoints — registered WITHOUT Compress middleware.
		// Gzip compression wraps the ResponseWriter and breaks http.Flusher
		// which is required for Server-Sent Events and streamed file downloads.
		r.Post("/update/apply", updateHandler.Apply)
		r.Get("/databases/{name}/backup", dbHandler.Backup)
	})

	// Server setup
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       65 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1MB
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Panel backend listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-done
	log.Println("Shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("Shutdown error: %v", err)
	}

	log.Println("Server stopped")
}

var startTime = time.Now()
