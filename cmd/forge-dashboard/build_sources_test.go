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
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestAuthStore(t *testing.T) *auth.Store {
	t.Helper()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	return store
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
		1, testGitHubAppPrivateKeyPEM, srv.URL, nil, nil, nil,
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
		1, []byte("not a pem"), srv.URL, nil, nil, nil,
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
		0, nil, srv.URL, nil, nil, nil,
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
		1, []byte("not a pem"), "", nil, nil, nil,
	)
	require.NotNil(t, source)

	result := source.Fetch(t.Context())

	assert.False(t, result.Health.Reachable)
}

func TestBuildGitHubSource_ClientsOnOneCacheShareAnItemsRenderedBody(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"body_html":"<a href=\"https://github.com/user-attachments/assets/a\"><img src=\"https://private-user-images.githubusercontent.com/s.png\"></a>"}`))
	}))
	t.Cleanup(srv.Close)
	cache := github.NewRenderedBodyCache()
	creds := settings.Credentials{GitHubToken: "pat-value"}
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	// A request builds its own client, as buildSources does.
	for range 2 {
		source := buildGitHubSource(creds, 0, nil, srv.URL, nil, nil, cache)
		resolver, ok := source.(dashboard.ImageLinkResolver)
		require.True(t, ok)
		_, err := resolver.SignedImageURL(t.Context(), "octo", "repo", item, "https://github.com/user-attachments/assets/a")
		require.NoError(t, err)
	}

	assert.EqualValues(t, 1, calls.Load())
}

// Not parallel: it points the package's GitHub API address at a local server.
func TestBuildSources_SourcesBuiltOnSeparateRequestsShareRenderedBodies(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"body_html":"<a href=\"https://github.com/user-attachments/assets/a\"><img src=\"https://private-user-images.githubusercontent.com/a.png\"></a><a href=\"https://github.com/user-attachments/assets/b\"><img src=\"https://private-user-images.githubusercontent.com/b.png\"></a>"}`))
	}))
	t.Cleanup(srv.Close)
	githubAPIBaseURL = srv.URL
	t.Cleanup(func() { githubAPIBaseURL = "" })
	build := buildSources(newTestAuthStore(t), nil, 0, nil, nil)
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	for _, link := range []string{"https://github.com/user-attachments/assets/a", "https://github.com/user-attachments/assets/b"} {
		sources := build(settings.Credentials{GitHubToken: "pat-value"})
		require.Len(t, sources, 1)
		resolver, ok := sources[0].(dashboard.ImageLinkResolver)
		require.True(t, ok)
		got, err := resolver.SignedImageURL(t.Context(), "octo", "repo", item, link)
		require.NoError(t, err)
		assert.NotEmpty(t, got)
	}

	assert.EqualValues(t, 1, calls.Load())
}
