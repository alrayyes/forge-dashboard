package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func alert(severity string) map[string]any {
	return map[string]any{"number": 1, "state": "open", "security_advisory": map[string]any{"severity": severity}}
}

func advisoryClient(t *testing.T, handler http.HandlerFunc) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/dependabot/alerts", handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestReadAdvisories_CountsOpenAlertsAndPicksHighestSeverity(t *testing.T) {
	t.Parallel()

	var query string
	client := advisoryClient(t, func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		writeJSON(t, w, []map[string]any{alert("low"), alert("critical"), alert("medium")})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{
		State: dashboard.AdvisoriesKnown, Count: 3, Highest: dashboard.SeverityCritical,
		URL: "https://github.com/alrayyes/a/security/dependabot",
	}, got)
	assert.Contains(t, query, "state=open")
}

func TestReadAdvisories_NoAlertsIsKnownZero(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []map[string]any{}) })

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.Zero(t, got.Count)
	assert.Empty(t, got.Highest)
}

func TestReadAdvisories_AlertsDisabledIsUnknownNotZero(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]any{"message": "Dependabot alerts are disabled for this repository."})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown}, got)
}

func TestReadAdvisories_MissingScopeIsUnknownNotZero(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "Resource not accessible by personal access token"})
	})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown}, got)
}

func TestReadAdvisories_ServerErrorIsAnError(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })

	_, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://github.com/alrayyes/a")

	require.Error(t, err)
}

func TestFetch_FillsEachDefaultBranchRowWithItsAdvisories(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"viewer": map[string]any{"repositories": map[string]any{
			"pageInfo": map[string]any{"hasNextPage": false},
			"nodes":    []map[string]any{repoNodeWithOwnerName()},
		}}}})
	})
	mux.HandleFunc("/repos/alrayyes/a/dependabot/alerts", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{alert("high")})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.MainBranches, 1)
	require.NotNil(t, result.MainBranches[0].Advisories)
	assert.Equal(t, dashboard.SeverityHigh, result.MainBranches[0].Advisories.Highest)
}
