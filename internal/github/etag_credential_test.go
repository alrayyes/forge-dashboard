package github_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// hooksServer answers the hook listing with an ETag and a 304 for a matching
// If-None-Match, and counts the conditional requests it received.
func etagHooksServer(t *testing.T) (srv *httptest.Server, conditional *atomic.Int32) {
	t.Helper()
	conditional = new(atomic.Int32)
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"v1"` {
			conditional.Add(1)
			w.WriteHeader(http.StatusNotModified)

			return
		}
		w.Header().Set("ETag", `"v1"`)
		writeJSON(t, w, []map[string]any{})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, conditional
}

// A rebuilt Client holding the same credential reuses what the first one
// learned, so a settings change that rebuilds the Client doesn't throw away
// answers that are still good.
func TestETagCache_SecondClientWithSameCredential_SendsIfNoneMatch(t *testing.T) {
	t.Parallel()

	srv, conditional := etagHooksServer(t)
	for range 2 {
		client := github.NewClient("shared-token", "", srv.URL)
		client.SetWebhookPath("/hook")
		_, err := client.HasWebhook(t.Context(), "alrayyes", "a")
		require.NoError(t, err)
	}

	assert.EqualValues(t, 1, conditional.Load())
}

// GitHub folds the credential into the ETag, so an ETag learned under one
// credential must never be offered under another.
func TestETagCache_ReplacedCredential_DoesNotSendTheOldETag(t *testing.T) {
	t.Parallel()

	srv, conditional := etagHooksServer(t)
	for _, token := range []string{"old-token", "new-token"} {
		client := github.NewClient(token, "", srv.URL)
		client.SetWebhookPath("/hook")
		_, err := client.HasWebhook(t.Context(), "alrayyes", "a")
		require.NoError(t, err)
	}

	assert.Zero(t, conditional.Load())
}

// The installation repository listing is the one REST read an App makes on
// every full refresh. Unchanged, the second listing must be a 304 and be
// counted as one, not charged as REST.
func TestAppClient_InstallationRepositoryList_SecondCallIsCountedAsNotModified(t *testing.T) {
	t.Parallel()

	srv, _, _ := appInstallationTestServer(t)
	var listings, conditional atomic.Int32
	inner := srv.Config.Handler
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/installation/repositories" {
			listings.Add(1)
			if r.Header.Get("If-None-Match") == `"inst1"` {
				conditional.Add(1)
				w.WriteHeader(http.StatusNotModified)

				return
			}
			w.Header().Set("ETag", `"inst1"`)
		}
		inner.ServeHTTP(w, r)
	})
	counters := apistats.New()
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetStats(counters, apistats.AppCredential(testInstallationID))

	first := client.Fetch(t.Context())
	second := client.Fetch(t.Context())

	require.True(t, second.Health.Reachable)
	assert.Equal(t, first.Health.RepoCount, second.Health.RepoCount, "the cached body answers the 304")
	assert.EqualValues(t, 2, listings.Load())
	assert.EqualValues(t, 1, conditional.Load())
	var notModified int64
	for _, b := range counters.Snapshot() {
		notModified += int64(b.NotModified)
	}
	assert.EqualValues(t, 1, notModified)
}
