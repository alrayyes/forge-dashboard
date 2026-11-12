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
	// refuse is what a merge or update of pull request 7 answers with.
	refuseStatus int
	refuseBody   string
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
	mux.HandleFunc("/api/v1/repos/o/r", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]string{"default_merge_style": "merge"})
	})
	refuse := func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		status, body := s.refuseStatus, s.refuseBody
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
	mux.HandleFunc("/api/v1/repos/o/r/pulls/7/merge", refuse)
	mux.HandleFunc("/api/v1/repos/o/r/pulls/7/update", refuse)
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

func (s *conflictServer) pull(t *testing.T) dashboard.PullRequest {
	t.Helper()

	prs, err := s.client.ListOpenPullRequests(t.Context(), "o", "r", "o/r")
	require.NoError(t, err)
	if len(prs) == 0 {
		return dashboard.PullRequest{}
	}

	return prs[0]
}

func (s *conflictServer) status(t *testing.T) dashboard.MergeStatus {
	t.Helper()

	return s.pull(t).MergeStatus
}

// refuseWith sets the answer a merge or update of pull request 7 gets.
func (s *conflictServer) refuseWith(status int, body string) {
	s.set(func(s *conflictServer) { s.refuseStatus, s.refuseBody = status, body })
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

// Forgejo answers a merge or an update that hits a conflict with 409 and git's
// own output. A row remembers that, so it says Conflicting before the window
// ends and names the files (#3308).

const gitConflictBody = `{"Style":"merge","StdOut":"Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n` +
	`CONFLICT (content): Merge conflict in docs/b.md\nAutomatic merge failed","StdErr":"","Err":{}}`

func confirmed(pr dashboard.PullRequest) string {
	if pr.ConflictConfirmed == nil {
		return "unset"
	}
	if *pr.ConflictConfirmed {
		return "confirmed"
	}

	return "unconfirmed"
}

func TestConflictMemory_NothingIsClaimedInsideTheWindow(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)

	assert.Equal(t, "unset", confirmed(s.pull(t)))
}

func TestConflictMemory_PastTheWindowWithNoRefusalIsUnconfirmed(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.advance(91 * time.Second)

	pr := s.pull(t)
	assert.Equal(t, dashboard.MergeConflicting, pr.MergeStatus)
	assert.Equal(t, "unconfirmed", confirmed(pr))
	assert.Empty(t, pr.ConflictFiles)
}

func TestConflictMemory_ARefusedMergeNamingAConflictIsConfirmedAtOnce(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, gitConflictBody)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))

	pr := s.pull(t)
	assert.Equal(t, dashboard.MergeConflicting, pr.MergeStatus)
	assert.Equal(t, "confirmed", confirmed(pr))
	assert.Equal(t, []string{"a.txt", "docs/b.md"}, pr.ConflictFiles)
}

func TestConflictMemory_ARefusedUpdateNamingAConflictIsConfirmedToo(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, `{"message":"Merge Conflict Error: CONFLICT (content): Merge conflict in a.txt"}`)
	_, err := s.client.UpdateBranch(t.Context(), "o", "r", 7)
	require.Error(t, err)

	pr := s.pull(t)
	assert.Equal(t, "confirmed", confirmed(pr))
	assert.Equal(t, []string{"a.txt"}, pr.ConflictFiles)
}

func TestConflictMemory_AConflictWithNoFilesIsStillConfirmed(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, `{"Style":"merge","StdOut":"","StdErr":"","Err":{}}`)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))

	pr := s.pull(t)
	assert.Equal(t, "confirmed", confirmed(pr))
	assert.Empty(t, pr.ConflictFiles)
}

func TestConflictMemory_ARefusalThatNamesNoConflictIsNotRemembered(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusMethodNotAllowed, `{"message":"Please try again later"}`)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictMemory_ANewHeadDropsIt(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, gitConflictBody)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))
	s.set(func(s *conflictServer) { s.head = "h2" })

	pr := s.pull(t)
	assert.Equal(t, dashboard.MergeChecking, pr.MergeStatus)
	assert.Equal(t, "unset", confirmed(pr))
	assert.Empty(t, pr.ConflictFiles)
}

func TestConflictMemory_ABasePushDropsIt(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, gitConflictBody)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))
	s.set(func(s *conflictServer) { s.base = "b2" })

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}

func TestConflictMemory_AFlagThatTurnsTrueDropsIt(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, gitConflictBody)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))
	s.set(func(s *conflictServer) { s.mergeable = true })
	s.pull(t)
	s.set(func(s *conflictServer) { s.mergeable = false })

	pr := s.pull(t)
	assert.Equal(t, dashboard.MergeChecking, pr.MergeStatus)
	assert.Equal(t, "unset", confirmed(pr))
}

func TestConflictMemory_A409ThatNamesNoConflictIsNotRemembered(t *testing.T) {
	t.Parallel()

	s := newConflictServer(t)
	s.pull(t)
	s.refuseWith(http.StatusConflict, `{"message":"Head out of date"}`)
	require.Error(t, s.client.MergePullRequest(t.Context(), "o", "r", 7))

	assert.Equal(t, dashboard.MergeChecking, s.status(t))
}
