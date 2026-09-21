package github_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeRecorder captures every Entry it's asked to record, and can be
// made to fail on demand — used to assert what a client persists
// without standing up a real database, and that a Record failure never
// changes the outbound call's own result.
type fakeRecorder struct {
	mu      sync.Mutex
	entries []requestlog.Entry
	err     error
}

func (r *fakeRecorder) Record(_ context.Context, e requestlog.Entry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, e)

	return r.err
}

func (r *fakeRecorder) all() []requestlog.Entry {
	r.mu.Lock()
	defer r.mu.Unlock()

	return append([]requestlog.Entry(nil), r.entries...)
}

func TestFetch_SuccessfulGraphQLFetch_RecordsOneEntryWithRateLimitFields(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "cost": 3, "remaining": 4922, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rec := &fakeRecorder{}
	client := github.NewClient("test-token", "", srv.URL, rec)
	client.Fetch(t.Context())

	entries := rec.all()
	require.Len(t, entries, 1)
	e := entries[0]
	assert.Equal(t, dashboard.ForgeGitHub, e.Forge)
	assert.Equal(t, http.MethodPost, e.Method)
	assert.Equal(t, requestlog.OutcomeSuccess, e.Outcome)
	assert.Equal(t, 200, e.StatusCode)
	// GraphQL's own rate-limit budget rides in the query's selected
	// "rateLimit" field, not in response headers the way REST and a
	// GraphQL-level failure both report it — graphqlDo (this entry's
	// single recording point, shared by every GraphQL query this client
	// makes, not just this one) has no query-specific field to read, so
	// a successful GraphQL entry's own rate-limit fields stay nil.
	assert.Nil(t, e.RateLimitLimit)
}

func TestFetch_RateLimitedGraphQLFailure_RecordsOneEntryClassifiedRateLimited(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]string{"message": "API rate limit exceeded."})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rec := &fakeRecorder{}
	client := github.NewClient("test-token", "", srv.URL, rec)
	client.Fetch(t.Context())

	entries := rec.all()
	require.Len(t, entries, 1)
	assert.Equal(t, string(dashboard.ForgeErrorRateLimited), entries[0].Outcome)
	assert.Equal(t, http.StatusForbidden, entries[0].StatusCode)
}

func TestFetch_RecorderError_DoesNotChangeFetchResult(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rec := &fakeRecorder{err: assert.AnError}
	client := github.NewClient("test-token", "", srv.URL, rec)
	result := client.Fetch(t.Context())

	assert.True(t, result.Health.Reachable)
	assert.Empty(t, result.Health.Error)
	assert.NotEmpty(t, rec.all(), "the failing Record call should still have been attempted")
}

func TestNewClient_NoRecorderGiven_StillWorks(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// No recorder argument at all — every pre-#482 call site's own shape.
	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	assert.True(t, result.Health.Reachable)
}
