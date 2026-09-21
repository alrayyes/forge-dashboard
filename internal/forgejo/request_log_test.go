package forgejo_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
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

func TestListRepos_Success_RecordsOneEntry(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rec := &fakeRecorder{}
	client := forgejo.NewClient(srv.URL, "test-token", "", rec)
	_, err := client.ListRepos(t.Context())
	require.NoError(t, err)

	entries := rec.all()
	require.Len(t, entries, 1)
	e := entries[0]
	assert.Equal(t, dashboard.ForgeForgejo, e.Forge)
	assert.Equal(t, http.MethodGet, e.Method)
	assert.Equal(t, requestlog.OutcomeSuccess, e.Outcome)
	assert.Equal(t, http.StatusOK, e.StatusCode)
	assert.Nil(t, e.RateLimitLimit, "Forgejo reports no rate-limit budget of its own")
}

func TestListRepos_RateLimited_RecordsOneEntryClassifiedRateLimited(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		writeJSON(t, w, map[string]string{"message": "too many requests"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rec := &fakeRecorder{}
	client := forgejo.NewClient(srv.URL, "test-token", "", rec)
	_, err := client.ListRepos(t.Context())
	require.Error(t, err)

	entries := rec.all()
	require.Len(t, entries, 1)
	assert.Equal(t, string(dashboard.ForgeErrorRateLimited), entries[0].Outcome)
	assert.Equal(t, http.StatusTooManyRequests, entries[0].StatusCode)
}

func TestListRepos_RecorderError_DoesNotChangeResult(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	rec := &fakeRecorder{err: assert.AnError}
	client := forgejo.NewClient(srv.URL, "test-token", "", rec)
	repos, err := client.ListRepos(t.Context())

	require.NoError(t, err)
	assert.Empty(t, repos)
	assert.NotEmpty(t, rec.all(), "the failing Record call should still have been attempted")
}

func TestNewClient_NoRecorderGiven_StillWorks(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// No recorder argument at all — every pre-#482 call site's own shape.
	client := forgejo.NewClient(srv.URL, "test-token", "")
	_, err := client.ListRepos(t.Context())

	require.NoError(t, err)
}
