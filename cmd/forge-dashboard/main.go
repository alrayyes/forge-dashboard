// Command forge-dashboard is the composition root: it wires the SQLite
// database, the passkey auth service, and the per-user dashboard.Manager,
// then serves the API and static frontend. See CLAUDE.md and the README
// for the environment variables that configure it.
package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
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

// defaultShutdownDrain is how long the server answers /readyz 503 before it
// stops accepting connections, so a router polling that path has taken it
// out of rotation first. Docker's default stop grace is 10s and Shutdown
// gets 5 of them, so a longer drain needs a longer stop_grace_period too.
// requestLogQueueSize is how many request-log rows wait for the single
// writer before a full queue starts dropping them.
const requestLogQueueSize = 256

const defaultShutdownDrain = 5 * time.Second

// resolveShutdownDrain reads SHUTDOWN_DRAIN as a Go duration. Zero turns the
// wait off; empty, invalid or negative falls back to the default.
func resolveShutdownDrain(v string) time.Duration {
	if v == "" {
		return defaultShutdownDrain
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		slog.Error("invalid SHUTDOWN_DRAIN, using default", "value", v, "default", defaultShutdownDrain, "error", err)

		return defaultShutdownDrain
	}

	return d
}

// drainThenShutdown flips readiness to 503, waits the drain delay so a
// router can notice, and only then shuts the server down.
func drainThenShutdown(delay time.Duration, startDrain func(), shutdown func(context.Context) error) error {
	startDrain()
	time.Sleep(delay)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return shutdown(shutdownCtx)
}

// defaultCIPollInterval is dashboard.PollCI's own ticker cadence
// (#177): real Forgejo instances (confirmed live, twice independently)
// silently drop the "status" webhook event from a hook's persisted
// event list even though the create/edit call reports success, so a
// finished check there never triggers the scoped refresh a working
// webhook would — it would otherwise wait out the full
// REFRESH_INTERVAL. A minute is short enough to feel live without
// spending real API budget: PollCI only ever touches repos with an
// open, CI-pending pull request, not every tracked one.
const defaultCIPollInterval = 1 * time.Minute

// resolveCIPollInterval is resolveRefreshInterval's own counterpart
// for CI_POLL_INTERVAL — same empty/invalid-falls-back-to-default
// shape. "0s" is a real, valid zero duration, not an error, so an
// operator can pass it to disable the poll entirely
// (Manager.SetCIPollInterval treats zero as "off").
func resolveCIPollInterval(v string) time.Duration {
	if v == "" {
		return defaultCIPollInterval
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		slog.Error("invalid CI_POLL_INTERVAL, using default", "value", v, "default", defaultCIPollInterval, "error", err)

		return defaultCIPollInterval
	}

	return d
}

func main() {
	// Checked before configureLogging/run: the container's own HEALTHCHECK
	// execs this binary with "healthcheck" as its only argument, and needs
	// nothing else this process would otherwise set up (no database, no
	// auth service) - just a fast, self-contained answer.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := runHealthcheck(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

		return
	}

	configureLogging()

	if err := run(); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}

// Startup errors, named so err113 sees static ones and a caller can match them.
var (
	errEncryptionKeyRequired = errors.New("ENCRYPTION_KEY is required (generate one with `openssl rand -base64 32`)")
	errAppPrivateKeyRequired = errors.New("GITHUB_APP_PRIVATE_KEY_BASE64 is required when GITHUB_APP_ID is set")
)

// errReadyzStatus is runHealthcheck's own sentinel - err113 wants a wrapped
// static error rather than a bare fmt.Errorf built from the status code
// alone.
var errReadyzStatus = errors.New("readyz check failed")

// runHealthcheck exists for the container's own HEALTHCHECK: the image is
// distroless (no shell, no curl, no wget), so there's nothing else inside it
// that could exec a probe. Reads the same ADDR this process would otherwise
// serve on and asks its own /readyz over loopback. Readiness, not liveness:
// Docker has one health state, and "healthy" is what Compose's
// service_healthy and the deploy pipeline act on, so it has to mean "can
// serve", not just "started". /healthz stays the cheap liveness answer.
func runHealthcheck() error {
	addr := envOr("ADDR", ":8080")

	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("parse addr %q: %w", addr, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/readyz", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("request /readyz: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: /readyz returned %d", errReadyzStatus, resp.StatusCode)
	}

	return nil
}

// run holds everything main used to, restructured to return an error
// instead of calling os.Exit directly — os.Exit skips every deferred
// call on the way out (gocritic's exitAfterDefer), which would have
// silently dropped the signal-context cancellation and, on any startup
// error past dashboard.NewManager, its own Stop too. Returning lets every
// defer here run before main decides whether to exit non-zero.
func run() error {
	addr := envOr("ADDR", ":8080")
	refreshInterval, ciPollInterval := resolveIntervals()

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

	githubAppID, githubAppPrivateKey, err := buildGitHubApp()
	if err != nil {
		return fmt.Errorf("github app setup failed: %w", err)
	}

	sharingStore := sharing.NewStore(db)
	if err := sharingStore.Init(ctx); err != nil {
		return fmt.Errorf("sharing setup failed: %w", err)
	}

	manager := newManager(settingsStore, refreshInterval, ciPollInterval)
	defer manager.Stop()

	// One writer for every request-log row (#902). Close drains what's
	// queued on the way out; a row logged after that is dropped, not a panic.
	requestLogWriter := requestlog.NewWriter(authStore, requestLogQueueSize)
	defer requestLogWriter.Close()

	var drain api.Drain
	deps := api.Deps{
		Drain:         &drain,
		Version:       version,
		AuthService:   authService,
		AuthStore:     authStore,
		SettingsStore: settingsStore,
		SharingStore:  sharingStore,
		Manager:       manager,
		Database:      schemaPinger{db: db},
		Dashboard:     manager,
		BuildSources:  buildSourcesForUser(authStore, requestLogWriter, githubAppID, githubAppPrivateKey),
		RequestLog:    requestlog.NewSQLiteRecorder(authStore, "", requestlog.WithWriter(requestLogWriter)),
		AppContext:    ctx,
		// Same env var buildAuth already required for WebAuthn's own
		// RPOrigins — reused rather than adding a second "what's my own
		// address" knob. See Deps.PublicOrigin's own doc comment.
		PublicOrigin:        envOr("RP_ORIGIN", "http://localhost:8080"),
		GitHubAppConfigured: githubAppID != 0,
	}

	slog.Info("starting", "version", version, "addr", addr, "refreshInterval", refreshInterval, "ciPollInterval", ciPollInterval)

	return serve(ctx, newServer(addr, deps), &drain)
}

// resolveIntervals reads how often to refresh everything and how often to poll
// CI, each with its own default.
func resolveIntervals() (refreshInterval, ciPollInterval time.Duration) {
	return resolveRefreshInterval(os.Getenv("REFRESH_INTERVAL")), resolveCIPollInterval(os.Getenv("CI_POLL_INTERVAL"))
}

// newServer is the HTTP server for deps, with the header timeout that keeps a
// slow client from holding a connection open.
func newServer(addr string, deps api.Deps) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           api.NewMux(deps),
		ReadHeaderTimeout: 5 * time.Second,
	}
}

// newManager is the per-user refresh manager, with the settings store as its
// list of repos to keep up to date.
func newManager(settingsStore *settings.Store, refreshInterval, ciPollInterval time.Duration) *dashboard.Manager {
	manager := dashboard.NewManager(refreshInterval)
	// settingsStore satisfies dashboard.AutoUpdateBranchLister (#365)
	// with its own AutoUpdateBranchRepos/RenovateRebaseLabel methods.
	manager.SetAutoUpdateBranchLister(settingsStore)
	manager.SetCIPollInterval(ciPollInterval)

	return manager
}

// serve runs srv until ctx is cancelled, then drains readiness before it stops
// the server, and answers whatever stopped it that wasn't that shutdown.
func serve(ctx context.Context, srv *http.Server, drain *api.Drain) error {
	go func() {
		<-ctx.Done()
		if err := drainThenShutdown(resolveShutdownDrain(os.Getenv("SHUTDOWN_DRAIN")), drain.Start, srv.Shutdown); err != nil {
			slog.Error("shutdown", "error", err)
		}
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server stopped: %w", err)
	}

	return nil
}

// buildGitHubSource picks this user's GitHub credential (#620): a
// connected App installation wins over a saved personal access token
// whenever both are set and the server has an App configured at all —
// PAT stays saved as an unused fallback/backup. handleSettingsPut
// already rejects saving an installation ID when the server has no App
// configured, so the "configured but construction still fails" branch
// below should essentially never fire outside a test; it exists so a
// user never silently loses GitHub polling entirely if it somehow does,
// with no PAT/username to fall back to either.
//
// github.Client implements dashboard.Source itself (GraphQL, one request
// per refresh) rather than going through GenericSource's
// one-REST-call-per-repo model.
//
// baseURL is always "" (the real GitHub API) from buildSourcesForUser;
// it's a parameter purely so a test can override it, the same testability
// NewClient/NewAppClient's own baseURL parameters already provide.
func buildGitHubSource(c settings.Credentials, githubAppID int64, githubAppPrivateKey []byte, baseURL string, recorder requestlog.Recorder) dashboard.Source {
	appConnected := githubAppID != 0 && c.GitHubAppInstallationID != 0
	if appConnected {
		client, err := github.NewAppClient(githubAppID, c.GitHubAppInstallationID, githubAppPrivateKey, baseURL, recorder)
		if err != nil {
			slog.Error("github app installation client failed, falling back", "installationId", c.GitHubAppInstallationID, "error", err)
		} else {
			if c.WebhookToken != "" {
				client.SetWebhookPath("/api/webhooks/github/" + c.WebhookToken)
			}
			// Dependabot ignores GitHub Apps, so its commands go out as the
			// saved personal token when there is one (#666).
			client.SetCommentToken(c.GitHubToken)

			return client
		}
	}

	switch {
	case c.GitHubToken != "":
		client := github.NewClient(c.GitHubToken, "", baseURL, recorder)
		if c.WebhookToken != "" {
			client.SetWebhookPath("/api/webhooks/github/" + c.WebhookToken)
		}

		return client
	case c.GitHubUsername != "":
		return github.NewClient("", c.GitHubUsername, baseURL, recorder)
	case appConnected:
		// The App branch above failed and there's nothing to fall back to
		// — surface it as a real forge-health error rather than silently
		// never adding a GitHub source at all.
		return github.NewUnreachableClient(fmt.Sprintf("github: app installation %d failed and no personal access token is saved as a fallback", c.GitHubAppInstallationID))
	default:
		return nil
	}
}

// buildSourcesForUser returns the per-user dashboard.Source builder Deps.
// BuildSources needs — a closure over authStore so every forge client it
// builds gets a requestlog.SQLiteRecorder bound to that specific user's
// own account ID (#482): the account whose credential made a request is
// known here, at construction, and nowhere else past this point, so this
// is where it has to be threaded in.

func buildSourcesForUser(authStore *auth.Store, requestLogWriter *requestlog.Writer, githubAppID int64, githubAppPrivateKey []byte) func(userID []byte, c settings.Credentials) []dashboard.Source {
	return func(userID []byte, c settings.Credentials) []dashboard.Source {
		var sources []dashboard.Source
		recorder := requestlog.NewSQLiteRecorder(authStore, base64.RawURLEncoding.EncodeToString(userID), requestlog.WithWriter(requestLogWriter))

		if src := buildGitHubSource(c, githubAppID, githubAppPrivateKey, "", recorder); src != nil {
			sources = append(sources, src)
		}

		switch {
		case c.ForgejoURL == "":
			// nothing configured for Forgejo at all
		case c.ForgejoToken != "":
			client := forgejo.NewClient(c.ForgejoURL, c.ForgejoToken, "", recorder)
			if c.WebhookToken != "" {
				client.SetWebhookPath("/api/webhooks/forgejo/" + c.WebhookToken)
			}
			sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
		case c.ForgejoUsername != "":
			client := forgejo.NewClient(c.ForgejoURL, "", c.ForgejoUsername, recorder)
			sources = append(sources, dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency))
		}

		return sources
	}
}

// schemaPinger is /readyz's database check: the connection answers and the
// tables the app reads on every request exist. The Init calls in run have
// already created them by the time the listener is up, so a failure here
// means the file went away or broke underneath a running process.
type schemaPinger struct{ db *sql.DB }

func (p schemaPinger) PingContext(ctx context.Context) error {
	if err := p.db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping: %w", err)
	}

	var one int
	err := p.db.QueryRowContext(ctx, "SELECT 1 FROM users LIMIT 1").Scan(&one)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("schema probe: %w", err)
	}

	return nil
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
		return nil, errEncryptionKeyRequired
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

// buildGitHubApp reads the GitHub App server-wide identity (#620) — the
// App itself is one thing shared by every user who installs it, so this
// is process-wide config, not per-user settings.Credentials, the same
// split ENCRYPTION_KEY already draws for the settings cipher. Returns
// appID == 0 when GITHUB_APP_ID is unset: App-mode is entirely optional,
// and every existing PAT-only deployment must keep working with no env
// changes at all.
func buildGitHubApp() (appID int64, privateKeyPEM []byte, err error) {
	raw := os.Getenv("GITHUB_APP_ID")
	if raw == "" {
		return 0, nil, nil
	}
	appID, err = strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, nil, fmt.Errorf("invalid GITHUB_APP_ID: %w", err)
	}

	keyB64 := os.Getenv("GITHUB_APP_PRIVATE_KEY_BASE64")
	if keyB64 == "" {
		return 0, nil, errAppPrivateKeyRequired
	}
	privateKeyPEM, err = base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return 0, nil, fmt.Errorf("decode GITHUB_APP_PRIVATE_KEY_BASE64: %w", err)
	}
	if err := github.ValidateAppPrivateKey(appID, privateKeyPEM); err != nil {
		return 0, nil, fmt.Errorf("validate GITHUB_APP_PRIVATE_KEY_BASE64: %w", err)
	}

	return appID, privateKeyPEM, nil
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
