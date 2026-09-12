// Command forge-dashboard is the composition root: it builds a Source per
// configured forge, starts the aggregator's background refresh, and serves
// the API and static frontend against whatever the aggregator most
// recently assembled. See CLAUDE.md and the README for the environment
// variables that configure it.
package main

import (
	"context"
	"database/sql"
	"errors"
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

	sources := buildSources()
	agg := dashboard.NewAggregator(sources)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go agg.Run(ctx, refreshInterval)

	authService, authStore, err := buildAuth(ctx)
	if err != nil {
		slog.Error("auth setup failed", "error", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.NewMux(agg.Get, authService, authStore),
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

	slog.Info("starting", "version", version, "addr", addr, "sources", len(sources), "refreshInterval", refreshInterval)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

// buildSources wires one dashboard.Source per forge that has enough
// configuration to be worth trying. A forge with nothing configured at
// all is skipped entirely rather than added and left to fail on every
// refresh — there's nothing useful to report about a forge nobody asked
// to watch.
func buildSources() []dashboard.Source {
	var sources []dashboard.Source

	token, username := os.Getenv("GITHUB_TOKEN"), os.Getenv("GITHUB_USERNAME")
	switch {
	case token != "":
		client := github.NewClient(token, "", "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeGitHub, client, dashboard.DefaultMaxConcurrency))
	case username != "":
		slog.Warn("GITHUB_TOKEN not set, falling back to GITHUB_USERNAME's public repos only", "username", username)
		client := github.NewClient("", username, "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeGitHub, client, dashboard.DefaultMaxConcurrency))
	default:
		slog.Warn("neither GITHUB_TOKEN nor GITHUB_USERNAME set, skipping GitHub")
	}

	forgejoURL := os.Getenv("FORGEJO_URL")
	forgejoToken, forgejoUsername := os.Getenv("FORGEJO_TOKEN"), os.Getenv("FORGEJO_USERNAME")
	switch {
	case forgejoURL == "":
		slog.Warn("FORGEJO_URL not set, skipping Forgejo")
	case forgejoToken != "":
		client := forgejo.NewClient(forgejoURL, forgejoToken, "")
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
	case forgejoUsername != "":
		slog.Warn("FORGEJO_TOKEN not set, falling back to FORGEJO_USERNAME's public repos only", "username", forgejoUsername)
		client := forgejo.NewClient(forgejoURL, "", forgejoUsername)
		sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
	default:
		slog.Warn("FORGEJO_URL set but neither FORGEJO_TOKEN nor FORGEJO_USERNAME set, skipping Forgejo")
	}

	return sources
}

// buildAuth opens (creating if needed) the SQLite database passkey
// registration, login and sessions persist to, and wires up the WebAuthn
// relying party from the environment. RP_ID and RP_ORIGIN default to a
// plain local dev run; a real deployment behind a real domain has to set
// both, or every registered passkey will be scoped to "localhost" and
// refuse to work there.
func buildAuth(ctx context.Context) (*auth.Service, *auth.Store, error) {
	dbPath := envOr("DB_PATH", "/data/forge-dashboard.db")
	if dir := filepath.Dir(dbPath); dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, nil, err
		}
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, nil, err
	}

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

	adminUsername := os.Getenv("ADMIN_USERNAME")
	if adminUsername == "" {
		slog.Warn("ADMIN_USERNAME not set — nobody will be able to register as an admin")
	}

	return auth.NewService(wa, store, adminUsername), store, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
