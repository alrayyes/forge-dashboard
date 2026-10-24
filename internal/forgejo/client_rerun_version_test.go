package forgejo_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.RerunChecksBlocker = (*forgejo.Client)(nil)

const noRerunReason = "This Forgejo is older than version 17 and has no way to rerun checks. Rerun them on the forge."

// swaggerPaths reads the Actions paths of a Forgejo API description kept in
// testdata: operation methods by path template.
func swaggerPaths(t *testing.T, file string) (version string, paths map[string]map[string]any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + file) //nolint:gosec // a fixed test fixture name
	require.NoError(t, err)
	var doc struct {
		Info  struct{ Version string }
		Paths map[string]map[string]any
	}
	require.NoError(t, json.Unmarshal(raw, &doc))

	return doc.Info.Version, doc.Paths
}

// The rerun route is pinned against the API description each Forgejo ships,
// not against a fake: Forgejo 17.0.0 has it, and 16.0.6 (the version the
// dashboard's own instance runs) has no rerun route of any kind.
func TestRerunRoute_IsInForgejo17sAPI_AndNotIn16s(t *testing.T) {
	t.Parallel()

	v17, paths17 := swaggerPaths(t, "swagger_actions_v17.0.0.json")
	assert.Equal(t, "17.0.0", v17)
	assert.Contains(t, paths17[forgejo.RerunJobPath], "post", "Forgejo 17.0.0 documents POST %s", forgejo.RerunJobPath)
	assert.Contains(t, paths17["/repos/{owner}/{repo}/actions/runs/{run_id}/jobs"], "get", "the jobs of a run are listed to find the failed ones")

	v16, paths16 := swaggerPaths(t, "swagger_actions_v16.0.6.json")
	assert.True(t, strings.HasPrefix(v16, "16.0.6"), v16)
	assert.NotContains(t, paths16, forgejo.RerunJobPath)
	for p := range paths16 {
		assert.NotContains(t, p, "rerun", "Forgejo 16.0.6 has no rerun route")
	}
}

// versionServer plays a Forgejo of one version for pull request 5, whose one
// failed run is 42.
type versionServer struct {
	fakeJobs

	version string
	// hang, when set, holds every /version read until it is closed.
	hang  chan struct{}
	mu    sync.Mutex
	reads int
}

func (s *versionServer) setVersion(v string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.version = v
}

func (s *versionServer) readCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.reads
}

func (s *versionServer) start(t *testing.T) *forgejo.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/version", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.reads++
		version := s.version
		s.mu.Unlock()
		if s.hang != nil {
			select {
			case <-s.hang:
			case <-r.Context().Done():
				return
			}
		}
		if version == "" {
			http.NotFound(w, r)

			return
		}
		writeJSON(t, w, map[string]any{"version": version})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42, "status": "failure", "commit_sha": "new", "prettyref": "main", "event": "push"}}})
	})
	s.jobs = map[int][]map[string]any{42: {job(142, "failure"), job(242, "success")}}
	s.register(t, mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestRerunChecksBlockedReason_ByForgejoVersion(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, version string
		blocked       bool
	}{
		{"16.0.6 has no rerun route", "16.0.6+gitea-1.22.0", true},
		{"15 has none either", "15.0.10+gitea-1.22.0", true},
		{"17.0.0 has it", "17.0.0+gitea-1.22.0", false},
		{"a 17 development build has it", "17.0.0-dev-1234-abcdef+gitea-1.22.0", false},
		{"a later major has it", "18.1.0+gitea-1.22.0", false},
		{"an unreadable version is left to the forge", "", false},
		{"a version in words is left to the forge", "nightly", false},
		{"a Gitea may have the route, so it is left to the forge", "1.22.0", false},
		{"a Forgejo before 7 reads like a Gitea, so it is left to the forge", "1.21.11+gitea-1.21.11", false},
		{"7.0.0 is the first Forgejo that can be told from a Gitea", "7.0.0+gitea-1.21.0", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			s := &versionServer{version: tt.version}

			reason := settled(s.start(t))

			if tt.blocked {
				assert.Equal(t, noRerunReason, reason)
			} else {
				assert.Empty(t, reason)
			}
		})
	}
}

func TestRerunChecksBlockedReason_ReadsTheVersionOnce(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0"}
	c := s.start(t)

	_ = settled(c)
	_ = settled(c)

	assert.Equal(t, 1, s.readCount())
}

func TestRerunFailedChecks_OnForgejo16_SaysSoAndPostsNothing(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0"}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.Equal(t, noRerunReason, dashboard.ForgeMessage(err))
	assert.Empty(t, s.rerunsSeen())
}

func TestRerunFailedDefaultBranchChecks_OnForgejo16_SaysSoAndPostsNothing(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0"}

	err := s.start(t).RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a", "main")

	assert.Equal(t, noRerunReason, dashboard.ForgeMessage(err))
	assert.Empty(t, s.rerunsSeen())
}

func TestRerunFailedChecks_OnForgejo17_PostsTheFailedJobRerun(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "17.0.0+gitea-1.22.0"}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.Equal(t, []string{"142"}, s.rerunsSeen())
}

// A refusal read "refused: refused: ..." because the raw request and the
// error classifier each added the word.
func TestRerunFailedChecks_RefusalSaysRefusedOnce(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.status = http.StatusNotFound

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
	assert.NotContains(t, err.Error(), "refused: refused")
	assert.Equal(t, 1, strings.Count(err.Error(), "refused"))
}
