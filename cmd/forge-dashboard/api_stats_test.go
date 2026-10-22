package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func countedCredentials(counters *apistats.Counters, forge string) []string {
	var out []string
	for _, b := range counters.Snapshot() {
		if b.Forge == forge {
			out = append(out, b.Credential)
		}
	}

	return out
}

func TestBuildGitHubSource_CountsATokenClientUnderItsLabel(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"viewer":{"repositories":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}`))
	}))
	defer srv.Close()
	counters := apistats.New()

	source := buildGitHubSource(settings.Credentials{GitHubToken: "pat-value"}, 0, nil, srv.URL, nil, counters)
	require.NotNil(t, source)
	source.Fetch(t.Context())

	assert.Contains(t, countedCredentials(counters, "github"), apistats.TokenCredential("pat-value"))
}

func TestBuildSources_CountsAForgejoClientUnderItsLabel(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	counters := apistats.New()

	sources := buildSources(newTestAuthStore(t), nil, 0, nil, counters)(settings.Credentials{ForgejoURL: srv.URL, ForgejoToken: "fj-value"})
	require.Len(t, sources, 1)
	sources[0].Fetch(t.Context())

	assert.Contains(t, countedCredentials(counters, string(dashboard.ForgeForgejo)), apistats.TokenCredential("fj-value"))
}
