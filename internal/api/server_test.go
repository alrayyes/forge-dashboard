package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func readJSON(resp *http.Response, v any) error {
	defer func() { _ = resp.Body.Close() }()
	return json.NewDecoder(resp.Body).Decode(v)
}

func TestHealthz_AnswersOK(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/healthz")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body api.Health
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "ok", body.Status)
}

func TestDashboard_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/dashboard")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDashboard_WithASession_SerializesEmptyArraysNotNull(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.NotContains(t, string(body), "null", "before any refresh, arrays should still be empty, not null")
}

func TestDashboard_ReturnsWhateverTheSnapshotFuncCurrentlyHolds(t *testing.T) {
	t.Parallel()

	want := dashboard.Snapshot{
		GeneratedAt:  time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC),
		Forges:       []dashboard.ForgeHealth{{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}},
		Issues:       []dashboard.Issue{},
	}

	srv := newTestServerWithSnapshot(t, func() dashboard.Snapshot { return want })
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var got dashboard.Snapshot
	require.NoError(t, readJSON(resp, &got))
	assert.Equal(t, want, got)
}
