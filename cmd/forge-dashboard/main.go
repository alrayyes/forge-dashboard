// Command forge-dashboard is the composition root: it wires the SQLite
// database, the passkey auth service, and the per-user dashboard.Manager,
// then serves the API and static frontend. See CLAUDE.md and the README
// for the environment variables that configure it.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/alrayyes/forge-dashboard/internal/sharing"
	"github.com/go-webauthn/webauthn/webauthn"
	_ "modernc.org/sqlite"
)

// version is stamped in at build time by goreleaser, from the tag. "dev" is
// what a plain `go build` reports, which is the honest answer for a binary
// built off an unknown tree.
var version = "dev"

const defaultRefreshInterval = 5 * time.Minute

func main() {
	addr := envOr("ADDR", ":8080")
	refreshInterval := defaultRefreshInterval
	if v := os.Getenv("REFRESH_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			slog.Error("invalid REFRESH_INTERVAL, using default", "value", v, "default", defaultRefreshInterval, "error", err)
		} else {
			refreshInterval = d
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := openDatabase()
	if err != nil {
		slog.Error("open database", "error", err)
		os.Exit(1)
	}

	authService, authStore, err := buildAuth(ctx, db)
	if err != nil {
		slog.Error("auth setup failed", "error", err)
		os.Exit(1)
	}

	settingsStore, err := buildSettingsStore(ctx, db)
	if err != nil {
		slog.Error("settings setup failed", "error", err)
		os.Exit(1)
	}

	sharingStore := sharing.NewStore(db)
	if err := sharingStore.Init(ctx); err != nil {
		slog.Error("sharing setup failed", "error", err)
		os.Exit(1)
	}

	manager := dashboard.NewManager(refreshInterval)
	defer manager.Stop()

	deps := api.Deps{
		Version:       version,
		AuthService:   authService,
		AuthStore:     authStore,
		SettingsStore: settingsStore,
		SharingStore:  sharingStore,
		Manager:       manager,
		BuildSources:  buildSourcesForUser,
		AppContext:    ctx,
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.NewMux(deps),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown", "error", err)
		}
	}()

	slog.Info("starting", "version", version, "addr", addr, "refreshInterval", refreshInterval)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

// buildSourcesForUser wires one dashboard.Source per forge c has enough
// configuration for. A forge with nothing set is skipped entirely — the
// per-user equivalent of v1's buildSources, now driven by a Settings save
// instead of GITHUB_TOKEN/FORGEJO_* environment variables.
func buildSourcesForUser(c settings.Credentials) []dashboard.Source {
	var sources []dashboard.Source

	switch {
	case c.GitHubToken != "":
		client := github.NewClient(c.GitHubToken, "", "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeGitHub, client, dashboard.DefaultMaxConcurrency))
	case c.GitHubUsername != "":
		client := github.NewClient("", c.GitHubUsername, "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeGitHub, client, dashboard.DefaultMaxConcurrency))
	}

	switch {
	case c.ForgejoURL == "":
		// nothing configured for Forgejo at all
	case c.ForgejoToken != "":
		client := forgejo.NewClient(c.ForgejoURL, c.ForgejoToken, "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
	case c.ForgejoUsername != "":
		client := forgejo.NewClient(c.ForgejoURL, "", c.ForgejoUsername)
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
	}

	return sources
}

// openDatabase opens (creating the containing directory if needed) the
// one SQLite file both auth and settings persist to.
//
// _busy_timeout and _journal_mode=WAL matter here specifically because
// this file sees concurrent writers from goroutines handling different
// requests at once — without a busy_timeout, SQLite's default is to fail
// a write immediately with SQLITE_BUSY ("database is locked") the moment
// it can't get the lock, rather than wait for the other writer to finish.
// Confirmed live: forge-dashboard#82.
func openDatabase() (*sql.DB, error) {
	dbPath := envOr("DB_PATH", "/data/forge-dashboard.db")
	if dir := filepath.Dir(dbPath); dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, err
		}
	}
	return sql.Open("sqlite", dbPath+"?_busy_timeout=5000&_journal_mode=WAL")
}

// buildAuth wires up the WebAuthn relying party from the environment.
// RP_ID and RP_ORIGIN default to a plain local dev run; a real deployment
// behind a real domain has to set both, or every registered passkey will
// be scoped to "localhost" and refuse to work there.
func buildAuth(ctx context.Context, db *sql.DB) (*auth.Service, *auth.Store, error) {
	store := auth.NewStore(db)
	if err := store.Init(ctx); err != nil {
		return nil, nil, err
	}

	rpID := envOr("RP_ID", "localhost")
	rpOrigin := envOr("RP_ORIGIN", "http://localhost:8080")
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "Forge Board",
		RPOrigins:     []string{rpOrigin},
	})
	if err != nil {
		return nil, nil, err
	}

	return auth.NewService(wa, store), store, nil
}

// buildSettingsStore requires a real ENCRYPTION_KEY — a service about to
// hold real GitHub/Forgejo tokens has to fail loudly at startup rather
// than silently store them in the clear because nobody set one.
func buildSettingsStore(ctx context.Context, db *sql.DB) (*settings.Store, error) {
	key := os.Getenv("ENCRYPTION_KEY")
	if key == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY is required (generate one with `openssl rand -base64 32`)")
	}

	cipher, err := settings.NewCipher(key)
	if err != nil {
		return nil, err
	}

	store := settings.NewStore(db, cipher)
	if err := store.Init(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
