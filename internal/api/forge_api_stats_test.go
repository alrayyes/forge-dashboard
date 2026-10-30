package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const statsToken = "stats-sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential

type forgeAPIStatsBody struct {
	Since   time.Time `json:"since"`
	Buckets []struct {
		Forge       string `json:"forge"`
		Credential  string `json:"credential"`
		Kind        string `json:"kind"`
		Repo        string `json:"repo"`
		REST        int64  `json:"rest"`
		GraphQL     int64  `json:"graphql"`
		GraphQLCost int64  `json:"graphqlCost"`
		NotModified int64  `json:"notModified"`
	} `json:"buckets"`
	Budgets []struct {
		Forge            string `json:"forge"`
		RateLimitGraphQL *struct {
			Remaining int `json:"remaining"`
		} `json:"rateLimitGraphQL"`
	} `json:"budgets"`
}

// statsServer is a signed-in server whose counters hold one row for the
// caller's own token and one for somebody else's.
func statsServer(t *testing.T) (*httptest.Server, *http.Cookie, *apistats.Counters) {
	t.Helper()

	counters := apistats.New()
	own := apistats.Key{Forge: "github", Credential: apistats.TokenCredential(statsToken), Kind: apistats.KindScopedWebhook, Repo: "alrayyes/a"}
	counters.Add(own, apistats.Count{GraphQL: 1, GraphQLCost: 3, REST: 2, NotModified: 4})
	counters.Add(apistats.Key{Forge: "github", Credential: apistats.TokenCredential("somebody-elses-token"), Kind: apistats.KindFull}, apistats.Count{REST: 9})

	src := &fakeConfiguredSource{health: dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: true,
		RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 4990, ResetsAt: time.Now().Add(time.Hour)},
	}}
	srv, _, _, _ := newTestServerWithSettingsStore(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != statsToken {
			return nil
		}

		return []dashboard.Source{src}
	}, false, 0, func(d *api.Deps) { d.APIStats = counters })
	cookie, _, _ := registerViaRealCeremony(t, srv)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings", `{"githubToken":"`+statsToken+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	return srv, cookie, counters
}

func TestContract_ForgeAPIStats(t *testing.T) {
	t.Parallel()

	srv, cookie, counters := statsServer(t)

	req, got := record(t, http.MethodGet, srv.URL+"/api/v1/stats/forge-api", cookie)
	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)

	var body forgeAPIStatsBody
	require.NoError(t, json.Unmarshal(got.body, &body))

	t.Run("says when counting began", func(t *testing.T) {
		t.Parallel()

		assert.WithinDuration(t, counters.Since(), body.Since, time.Second)
	})
	t.Run("returns the caller's own bucket with every count", func(t *testing.T) {
		t.Parallel()

		require.Len(t, body.Buckets, 1)
		b := body.Buckets[0]
		assert.Equal(t, "scoped_webhook", b.Kind)
		assert.Equal(t, "alrayyes/a", b.Repo)
		assert.EqualValues(t, 3, b.GraphQLCost)
		assert.EqualValues(t, 4, b.NotModified)
	})
	t.Run("leaves out another credential's buckets", func(t *testing.T) {
		t.Parallel()

		for _, b := range body.Buckets {
			assert.NotEqual(t, apistats.TokenCredential("somebody-elses-token"), b.Credential)
		}
	})
	t.Run("never carries the token itself", func(t *testing.T) {
		t.Parallel()

		assert.NotContains(t, string(got.body), statsToken)
	})
	t.Run("reports the budget the forge last gave", func(t *testing.T) {
		t.Parallel()

		require.Len(t, body.Budgets, 1)
		require.NotNil(t, body.Budgets[0].RateLimitGraphQL)
		assert.Equal(t, 4990, body.Budgets[0].RateLimitGraphQL.Remaining)
	})
	t.Run("without a session", func(t *testing.T) {
		t.Parallel()

		req, got := record(t, http.MethodGet, srv.URL+"/api/v1/stats/forge-api", nil)
		require.Equal(t, http.StatusUnauthorized, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
	})
}

func TestForgeAPIStats_RightAfterAStartEveryCounterIsZero(t *testing.T) {
	t.Parallel()

	srv, cookie, _ := statsServerWithoutCounts(t)

	req, got := record(t, http.MethodGet, srv.URL+"/api/v1/stats/forge-api", cookie)
	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)

	var body forgeAPIStatsBody
	require.NoError(t, json.Unmarshal(got.body, &body))
	assert.Empty(t, body.Buckets)
	assert.False(t, body.Since.IsZero())
}

func TestMCP_GetForgeAPIStats_ReturnsTheSamePayloadAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	srv, cookie, _ := statsServer(t)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_forge_api_stats"})
	require.NoError(t, err)
	require.False(t, result.IsError)

	_, got := record(t, http.MethodGet, srv.URL+"/api/v1/stats/forge-api", cookie)
	var httpBody map[string]any
	require.NoError(t, json.Unmarshal(got.body, &httpBody))
	assert.Equal(t, httpBody, result.StructuredContent)
}

func statsServerWithoutCounts(t *testing.T) (*httptest.Server, *http.Cookie, *apistats.Counters) {
	t.Helper()

	counters := apistats.New()
	srv, _, _, _ := newTestServerWithSettingsStore(t, func(settingspkg.Credentials) []dashboard.Source { return nil },
		false, 0, func(d *api.Deps) { d.APIStats = counters })
	cookie, _, _ := registerViaRealCeremony(t, srv)

	return srv, cookie, counters
}
