package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A Forgejo pull request that is not mergeable on a moved base may only be
// rechecking, so it reads Checking for a short window and Conflicting once the
// flag has stayed false past it (#3304).

type conflictServer struct {
	mu        sync.Mutex
	mergeable bool
	head      string
	base      string
	listed    bool
	now       time.Time
	client    *forgejo.Client
}

func newConflictServer(t *testing.T) *conflictServer {
	t.Helper()

	s := &conflictServer{head: "h1", base: "b1", listed: true, now: time.Date(2026, 11, 9, 16, 0, 0, 0, time.UTC)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/o/r/pulls", func(w http.ResponseWriter, req *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if req.URL.Query().Get("page") != "1" || !s.listed {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 7, "title": "t", "html_url": "https://git.example/o/r/pulls/7",
			"user": map[string]string{"login": "u"}, "labels": []map[string]string{},
			"mergeable": s.mergeable, "merge_base": "old",
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]string{"sha": s.head}, "base": map[string]string{"sha": s.base},
		}})
	})
	mux.HandleFunc("/api/v1/repos/o/r/commits/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]string{"state": "success"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	s.client = forgejo.NewClient(srv.URL, "tok", "")
	forgejo.SetConflictClock(s.client, func() time.Time {
		s.mu.Lock()
		defer s.mu.Unlock()

		return s.now
	})

	return s
}

func (s *conflictServer) advance(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = s.now.Add(d)
}

func (s *conflictServer) set(f func(*conflictServer)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func (s *conflictServer) status(t *testing.T) dashboard.MergeStatus {
	t.Helper()

	prs, err := s.client.ListOpenPullRequests(t.Context(), "o", "r", "o/r")
	require.NoError(t, err)
	if len(prs) == 0 {
		return ""
	}

	return prs[0].MergeStatus
}

func TestConflictWindow_FirstSightIsChecking(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictWindow_StillCheckingInsideTheWindow(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.status(t)
	s.advance(60 * time.Second)

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictWindow_ConflictingOnceTheWindowPasses(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.status(t)
	s.advance(91 * time.Second)

	assert.Equal(t, dashboard.MergeConflicting, s.status(t))
}

func TestConflictWindow_NewBaseSHAStartsTheWindowAgain(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.status(t)
	s.advance(91 * time.Second)
	s.set(func(s *conflictServer) { s.base = "b2" })

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictWindow_NewHeadSHAStartsTheWindowAgain(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.status(t)
	s.advance(91 * time.Second)
	s.set(func(s *conflictServer) { s.head = "h2" })

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictWindow_AFlagThatTurnsTrueIsForgottenSoItStartsAgain(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.status(t)
	s.advance(91 * time.Second)
	s.set(func(s *conflictServer) { s.mergeable = true })
	s.status(t)
	s.set(func(s *conflictServer) { s.mergeable = false })

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictWindow_AClosedPullRequestIsForgotten(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.status(t)
	s.advance(91 * time.Second)
	s.set(func(s *conflictServer) { s.listed = false })
	s.status(t)
	s.set(func(s *conflictServer) { s.listed = true })

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}
