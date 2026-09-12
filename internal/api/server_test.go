package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHealthz_AnswersOK(t *testing.T) {
	t.Parallel()

	mux := api.NewMux(func() dashboard.Snapshot { return dashboard.Snapshot{} })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var body api.Health
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ok", body.Status)
}

func TestDashboard_ReturnsWhateverTheSnapshotFuncCurrentlyHolds(t *testing.T) {
	t.Parallel()

	want := dashboard.Snapshot{
		GeneratedAt:  time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC),
		Forges:       []dashboard.ForgeHealth{{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}},
		Issues:       []dashboard.Issue{},
	}
	mux := api.NewMux(func() dashboard.Snapshot { return want })

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var got dashboard.Snapshot
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, want, got)
}

func TestDashboard_BeforeFirstRefresh_SerializesEmptyArraysNotNull(t *testing.T) {
	t.Parallel()

	agg := dashboard.NewAggregator(nil)
	mux := api.NewMux(agg.Get)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/dashboard", nil)
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.NotContains(t, rec.Body.String(), "null", "before any refresh, arrays should still be empty, not null")
}
