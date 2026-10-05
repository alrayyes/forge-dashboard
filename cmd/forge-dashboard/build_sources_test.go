package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestAuthStore(t *testing.T) *auth.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "auth.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	return store
}

// TestBuildSourcesForUser_TwoUsers_RecordUnderTwoDistinctAccountIDs is
// task 2.5's own acceptance criterion: each account's forge clients
// have to record under that account's own ID, not a shared or empty
// one, since correlating a shared-credential problem (#435's suspected
// cause) is the entire reason #482 exists. Forgejo, not GitHub, because
// its instanceURL is configurable per-user (settings.Credentials.
// ForgejoURL) — this is what lets the test point real clients at an
// httptest server and observe a genuine recorded request, rather than
// only inspecting how the client was constructed.
func TestBuildSourcesForUser_TwoUsers_RecordUnderTwoDistinctAccountIDs(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	store := newTestAuthStore(t)
	build := buildSourcesForUser(store, nil, 0, nil)

	userA, err := store.CreateUser(t.Context(), "user-a", "User A", false)
	require.NoError(t, err)
	userB, err := store.CreateUser(t.Context(), "user-b", "User B", false)
	require.NoError(t, err)

	creds := settings.Credentials{ForgejoURL: srv.URL, ForgejoToken: "test-token"}

	sourcesA := build(userA.ID, creds)
	sourcesB := build(userB.ID, creds)
	require.Len(t, sourcesA, 1)
	require.Len(t, sourcesB, 1)

	sourcesA[0].Fetch(t.Context())
	sourcesB[0].Fetch(t.Context())

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 2)

	accountA := base64.RawURLEncoding.EncodeToString(userA.ID)
	accountB := base64.RawURLEncoding.EncodeToString(userB.ID)
	gotAccounts := []string{rows[0].AccountID, rows[1].AccountID}
	assert.ElementsMatch(t, []string{accountA, accountB}, gotAccounts)
	assert.NotEqual(t, accountA, accountB)
}

// testGitHubAppPrivateKeyPEM is a throwaway RSA key generated once and
// reused across every #620 precedence test in this file.
var testGitHubAppPrivateKeyPEM = generateTestGitHubAppPrivateKeyPEM()

func generateTestGitHubAppPrivateKeyPEM() []byte {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
}

// githubAppTestServer serves the installation-token-minting endpoint,
// GET /installation/repositories (fetchAppRepos' own repo-discovery
// call — #625) and /graphql, reporting back which Authorization scheme
// actually reached it — "token ..." for an App installation, "Bearer
// ..." for a personal access token — so a test can prove which
// credential buildGitHubSource actually picked without needing to
// inspect the *github.Client's own unexported fields. The installation
// listing returns zero repos: these tests only care which credential
// won, not what it fetched, and fetchAppRepos captures the same auth
// header on that REST call before it would ever reach /graphql for an
// empty repo list.
func githubAppTestServer(t *testing.T) (srv *httptest.Server, lastAuthHeader *string) {
	t.Helper()
	lastAuthHeader = new(string)

	mux := http.NewServeMux()
	mux.HandleFunc("/app/installations/42/access_tokens", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"installation-token-value","expires_at":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, r *http.Request) {
		*lastAuthHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"total_count":0,"repositories":[]}`))
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		*lastAuthHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"rateLimit":{"limit":5000,"remaining":5000,"resetAt":"2026-09-14T16:00:00Z"},"viewer":{"repositories":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}`))
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, lastAuthHeader
}

func TestBuildGitHubSource_BothAppInstallationAndToken_AppWins(t *testing.T) {
	t.Parallel()

	srv, lastAuthHeader := githubAppTestServer(t)

	source := buildGitHubSource(
		settings.Credentials{GitHubToken: "pat-value", GitHubAppInstallationID: 42},
		1, testGitHubAppPrivateKeyPEM, srv.URL, nil,
	)
	require.NotNil(t, source)

	source.Fetch(t.Context())

	assert.Contains(t, *lastAuthHeader, "installation-token-value", "the App installation should have won over the saved PAT")
}

func TestBuildGitHubSource_AppConstructionFails_FallsBackToToken(t *testing.T) {
	t.Parallel()

	srv, lastAuthHeader := githubAppTestServer(t)

	// A malformed key makes github.NewAppClient fail construction
	// outright, so the fallback to the saved PAT is what actually ends
	// up being used.
	source := buildGitHubSource(
		settings.Credentials{GitHubToken: "pat-value", GitHubAppInstallationID: 42},
		1, []byte("not a pem"), srv.URL, nil,
	)
	require.NotNil(t, source)

	source.Fetch(t.Context())

	assert.Equal(t, "Bearer pat-value", *lastAuthHeader)
}

func TestBuildGitHubSource_InstallationIdSetButNoServerApp_FallsBackToToken(t *testing.T) {
	t.Parallel()

	srv, lastAuthHeader := githubAppTestServer(t)

	// githubAppID == 0: the server has no App configured at all — a
	// stale saved installation ID (e.g. an operator removed
	// GITHUB_APP_ID after users had already connected) must not block
	// the existing PAT from working.
	source := buildGitHubSource(
		settings.Credentials{GitHubToken: "pat-value", GitHubAppInstallationID: 42},
		0, nil, srv.URL, nil,
	)
	require.NotNil(t, source)

	source.Fetch(t.Context())

	assert.Equal(t, "Bearer pat-value", *lastAuthHeader)
}

func TestBuildGitHubSource_AppFailsWithNoFallback_ReportsHealthError(t *testing.T) {
	t.Parallel()

	// No GitHubToken, no GitHubUsername — nothing to fall back to once
	// the (deliberately broken) App branch fails.
	source := buildGitHubSource(
		settings.Credentials{GitHubAppInstallationID: 42},
		1, []byte("not a pem"), "", nil,
	)
	require.NotNil(t, source)

	result := source.Fetch(t.Context())

	assert.False(t, result.Health.Reachable)
}
