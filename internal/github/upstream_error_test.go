package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GitHub answering with a gateway error is not GitHub being unreachable
// (#3527): the banner must say it answered, and with what.
func TestFetch_AGatewayErrorAfterTheRetriesIsAnUpstreamError(t *testing.T) {
	t.Parallel()

	for status, text := range map[int]string{
		http.StatusBadGateway:         "GitHub returned 502 Bad Gateway",
		http.StatusServiceUnavailable: "GitHub returned 503 Service Unavailable",
		http.StatusGatewayTimeout:     "GitHub returned 504 Gateway Timeout",
	} {
		t.Run(text, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
			}))
			t.Cleanup(srv.Close)

			result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

			require.False(t, result.Health.Reachable)
			assert.Equal(t, dashboard.ForgeErrorUpstream, result.Health.ErrorKind)
			assert.Equal(t, status, result.Health.UpstreamStatus)
			assert.Equal(t, text, result.Health.Error)
		})
	}
}

func TestFetch_ARefusedConnectionStaysUnreachable(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	result := github.NewClient("test-token", "", url).Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, result.Health.ErrorKind)
	assert.Zero(t, result.Health.UpstreamStatus)
}

// Retries of one request must not wait the same time, or a burst of requests
// that failed together retries together (#3527).
func TestRetryDelay_IsJitteredAroundTheBase(t *testing.T) {
	t.Parallel()

	const base = 400 * time.Millisecond
	seen := map[time.Duration]bool{}
	for range 200 {
		d := github.RetryDelayForTest(base)
		assert.GreaterOrEqual(t, d, base/2)
		assert.LessOrEqual(t, d, base*3/2)
		seen[d] = true
	}
	assert.Greater(t, len(seen), 20, "the delay varies")
}

// The retry loop must use the jittered wait, not the bare base.
func TestFetch_TheGraphQLRetryWaitsAreJittered(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusGatewayTimeout)
	}))
	t.Cleanup(srv.Close)

	first := map[time.Duration]bool{}
	for range 20 {
		var waits []time.Duration
		client := github.NewClient("test-token", "", srv.URL)
		github.SetRetryWaitForTest(client, func(d time.Duration) { waits = append(waits, d) })

		client.Fetch(t.Context())

		require.NotEmpty(t, waits)
		first[waits[0]] = true
	}

	assert.Greater(t, len(first), 1, "the first retry wait differs between requests")
}
