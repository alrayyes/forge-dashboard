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
	"strings"
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

// defaultRefreshInterval was 5 minutes, sized around polling being the
// only way an update ever arrived. Every tracked repo gets a real webhook
// now (#361's own prerequisite), so the poll is a reconciliation safety
// net, not the primary channel — standard webhook-plus-reconciliation-
// polling practice recommends 15-60 minutes for that role, and 20 sits
// in the middle of it (#381).
const defaultRefreshInterval = 20 * time.Minute

// resolveRefreshInterval parses v (REFRESH_INTERVAL's raw value) as a Go
// duration, falling back to defaultRefreshInterval for an empty or
// unparseable value — split out from main so the fallback behavior is
// unit-testable without standing up the rest of the process.
func resolveRefreshInterval(v string) time.Duration {
	if v == "" {
		return defaultRefreshInterval
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		slog.Error("invalid REFRESH_INTERVAL, using default", "value", v, "default", defaultRefreshInterval, "error", err)

		return defaultRefreshInterval
	}

	return d
}

func main() {
	configureLogging()

	if err := run(); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}

// run holds everything main used to, restructured to return an error
// instead of calling os.Exit directly — os.Exit skips every deferred
// call on the way out (gocritic's exitAfterDefer), which would have
// silently dropped the signal-context cancellation and, on any startup
// error past dashboard.NewManager, its own Stop too. Returning lets every
// defer here run before main decides whether to exit non-zero.
func run() error {
	addr := envOr("ADDR", ":8080")
	refreshInterval := resolveRefreshInterval(os.Getenv("REFRESH_INTERVAL"))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := openDatabase()
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}

	authService, authStore, err := buildAuth(ctx, db)
	if err != nil {
		return fmt.Errorf("auth setup failed: %w", err)
	}

	settingsStore, err := buildSettingsStore(ctx, db)
	if err != nil {
		return fmt.Errorf("settings setup failed: %w", err)
	}

	sharingStore := sharing.NewStore(db)
	if err := sharingStore.Init(ctx); err != nil {
		return fmt.Errorf("sharing setup failed: %w", err)
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
		// Same env var buildAuth already required for WebAuthn's own
		// RPOrigins — reused rather than adding a second "what's my own
		// address" knob. See Deps.PublicOrigin's own doc comment.
		PublicOrigin: envOr("RP_ORIGIN", "http://localhost:8080"),
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
		return fmt.Errorf("server stopped: %w", err)
	}

	return nil
}

// buildSourcesForUser wires one dashboard.Source per forge c has enough
// configuration for. A forge with nothing set is skipped entirely — the
// per-user equivalent of v1's buildSources, now driven by a Settings save
// instead of GITHUB_TOKEN/FORGEJO_* environment variables.
//
// c.WebhookToken (settings.Store.EnsureWebhookCredentials, generated the
// first time Settings is opened) is what lets each client recognize its
// own webhook among a repo's — see dashboard.WebhookTargetsPath. Left
// blank (a user who saved forge credentials but has never opened
// Settings yet), both clients skip the live check entirely rather than
// erroring; the delivery-table signal in buildDashboardResponse still
// covers them once they do.
func buildSourcesForUser(c settings.Credentials) []dashboard.Source {
	var sources []dashboard.Source

	switch {
	case c.GitHubToken != "":
		// github.Client implements dashboard.Source itself (GraphQL, one
		// request per refresh) rather than going through GenericSource's
		// one-REST-call-per-repo model.
		client := github.NewClient(c.GitHubToken, "", "")
		if c.WebhookToken != "" {
			client.SetWebhookPath("/api/webhooks/github/" + c.WebhookToken)
		}
		sources = append(sources, client)
	case c.GitHubUsername != "":
		sources = append(sources, github.NewClient("", c.GitHubUsername, ""))
	}

	switch {
	case c.ForgejoURL == "":
		// nothing configured for Forgejo at all
	case c.ForgejoToken != "":
		client := forgejo.NewClient(c.ForgejoURL, c.ForgejoToken, "")
		if c.WebhookToken != "" {
			client.SetWebhookPath("/api/webhooks/forgejo/" + c.WebhookToken)
		}
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
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", dbPath+"?_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	return db, nil
}

// buildAuth wires up the WebAuthn relying party from the environment.
// RP_ID and RP_ORIGIN default to a plain local dev run; a real deployment
// behind a real domain has to set both, or every registered passkey will
// be scoped to "localhost" and refuse to work there.
func buildAuth(ctx context.Context, db *sql.DB) (*auth.Service, *auth.Store, error) {
	store := auth.NewStore(db)
	if err := store.Init(ctx); err != nil {
		return nil, nil, fmt.Errorf("init auth store: %w", err)
	}

	rpID := envOr("RP_ID", "localhost")
	rpOrigin := envOr("RP_ORIGIN", "http://localhost:8080")
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "Forge Board",
		RPOrigins:     []string{rpOrigin},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("configure webauthn relying party: %w", err)
	}

	return auth.NewService(wa, store), store, nil
}

// buildSettingsStore requires a real ENCRYPTION_KEY — a service about to
// hold real GitHub/Forgejo tokens has to fail loudly at startup rather
// than silently store them in the clear because nobody set one.
func buildSettingsStore(ctx context.Context, db *sql.DB) (*settings.Store, error) {
	key := os.Getenv("ENCRYPTION_KEY")
	if key == "" {
		return nil, errors.New("ENCRYPTION_KEY is required (generate one with `openssl rand -base64 32`)")
	}

	cipher, err := settings.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("build settings cipher: %w", err)
	}

	store := settings.NewStore(db, cipher)
	if err := store.Init(ctx); err != nil {
		return nil, fmt.Errorf("init settings store: %w", err)
	}

	return store, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}

	return fallback
}

// configureLogging replaces the default slog logger with one honoring
// LOG_LEVEL, so a real production incident (a request-rate burst, a
// refresh that's misbehaving) can be diagnosed from the process's own
// logs instead of reasoning about the code from the outside. Both forge
// clients log a debug line per outbound request — count lines per second
// against real logs to see exactly what a burst looked like, rather than
// only being able to say what the code should do.
func configureLogging() {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
}
