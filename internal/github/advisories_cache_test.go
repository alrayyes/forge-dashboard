package github_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// advisoryFetchServer serves one repo and the alerts handler, counting alert reads.
func advisoryFetchServer(t *testing.T, hits *atomic.Int32, handler http.HandlerFunc) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"viewer": map[string]any{"repositories": map[string]any{
			"pageInfo": map[string]any{"hasNextPage": false},
			"nodes":    []map[string]any{repoNodeWithOwnerName()},
		}}}})
	})
	mux.HandleFunc("/repos/alrayyes/a/dependabot/alerts", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		handler(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func advisoriesOf(t *testing.T, client *github.Client) *dashboard.Advisories {
	t.Helper()
	result := client.Fetch(t.Context())
	require.Len(t, result.MainBranches, 1)

	return result.MainBranches[0].Advisories
}

func TestReadAdvisories_FollowsTheCursorAcrossPages(t *testing.T) {
	t.Parallel()

	var client *github.Client
	client = advisoryClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("after") == "" {
			w.Header().Set("Link", `<`+client.BaseURLForTest()+`/repos/alrayyes/a/dependabot/alerts?state=open&after=abc>; rel="next"`)
			writeJSON(t, w, []map[string]any{alert("low"), alert("medium")})

			return
		}
		assert.Equal(t, "abc", r.URL.Query().Get("after"))
		writeJSON(t, w, []map[string]any{alert("critical")})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, 3, got.Count)
	assert.Equal(t, dashboard.SeverityCritical, got.Highest)
}

func TestReadAdvisories_PastThePageCapIsUnknownNotATruncatedCount(t *testing.T) {
	t.Parallel()

	var client *github.Client
	client = advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", `<`+client.BaseURLForTest()+`/repos/alrayyes/a/dependabot/alerts?state=open&after=more>; rel="next"`)
		writeJSON(t, w, []map[string]any{alert("low")})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Zero(t, got.Count)
}

func TestFetch_ReusesAdvisoriesUntilTheyExpire(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []map[string]any{alert("low")}) })

	advisoriesOf(t, client)
	advisoriesOf(t, client)
	assert.Equal(t, int32(1), hits.Load(), "second poll reads the cache")

	client.ExpireAdvisories()
	advisoriesOf(t, client)
	assert.Equal(t, int32(2), hits.Load(), "an expired answer is read again")
}

func TestFetch_KeepsTheLastKnownAnswerWhenARefreshFails(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var fail atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusBadGateway)

			return
		}
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	advisoriesOf(t, client)
	fail.Store(true)
	client.ExpireAdvisories()

	got := advisoriesOf(t, client)

	require.NotNil(t, got)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.Equal(t, 1, got.Count)
}

func TestFetch_ABrokenAdvisoryReadBacksOffInsteadOfRetryingEveryPoll(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })

	first := advisoriesOf(t, client)
	advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesUnknown, first.State)
	assert.Equal(t, int32(1), hits.Load())
}

func TestFetch_ARateLimitedRefreshKeepsTheKnownAnswer(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var limited atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if limited.Load() {
			w.Header().Set("X-RateLimit-Limit", "5000")
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", "4102444800")
			w.WriteHeader(http.StatusForbidden)
			writeJSON(t, w, map[string]any{"message": "API rate limit exceeded"})

			return
		}
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	advisoriesOf(t, client)
	limited.Store(true)
	client.ExpireAdvisories()

	got := advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
}

func TestFetch_AlertsSwitchedOffAfterAKnownAnswerReplacesIt(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	var off atomic.Bool
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) {
		if off.Load() {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	advisoriesOf(t, client)
	off.Store(true)
	client.ExpireAdvisories()

	got := advisoriesOf(t, client)

	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
}

func TestFetch_CountsAdvisoryReadsUnderTheirOwnKind(t *testing.T) {
	t.Parallel()

	var hits atomic.Int32
	client := advisoryFetchServer(t, &hits, func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []map[string]any{}) })
	counters := apistats.New()
	client.SetStats(counters, "token:abcd")

	advisoriesOf(t, client)

	var advisoryReads int64
	for _, b := range counters.Snapshot() {
		if b.Kind == apistats.KindAdvisories {
			advisoryReads += b.REST + b.NotModified
		}
	}
	assert.Equal(t, int64(1), advisoryReads)
}
