package api_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/legacy"
	"github.com/stretchr/testify/require"
)

// These tests check what the server answers against api/openapi.yaml, the
// contract the SDKs are generated from (#880). Each one records a real
// response from the test server and asks kin-openapi whether the spec allows
// it: status, headers and body. A handler that drops or renames a required
// field, or returns a shape the spec doesn't describe, fails here.

// recorded is one response, read in full.
type recorded struct {
	status int
	header http.Header
	body   []byte
}

// validateAgainstSpec checks a recorded response against the operation the
// spec has for req.
func validateAgainstSpec(t *testing.T, req *http.Request, got recorded) {
	t.Helper()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	// The spec's server is a template with no canonical host; the router only
	// needs to match the path.
	doc.Servers = nil
	router, err := legacy.NewRouter(doc)
	require.NoError(t, err)

	route, pathParams, err := router.FindRoute(req)
	require.NoError(t, err, "the spec has no operation for %s %s", req.Method, req.URL.Path)

	err = openapi3filter.ValidateResponse(t.Context(), &openapi3filter.ResponseValidationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{
			Request:    req,
			PathParams: pathParams,
			Route:      route,
			Options:    &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
		},
		Status:  got.status,
		Header:  got.header,
		Body:    io.NopCloser(bytes.NewReader(got.body)),
		Options: &openapi3filter.Options{IncludeResponseStatus: true},
	})
	require.NoError(t, err, "%s %s answered %d with %s", req.Method, req.URL.Path, got.status, string(got.body))
}

// record makes one call and reads the whole response.
func record(t *testing.T, method, url string, cookie *http.Cookie) (*http.Request, recorded) {
	t.Helper()

	req, err := http.NewRequest(method, url, nil)
	require.NoError(t, err)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return req, recorded{status: resp.StatusCode, header: resp.Header, body: body}
}

func TestContract_HealthAndReadiness(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for _, path := range []string{"/healthz", "/readyz"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req, got := record(t, http.MethodGet, srv.URL+path, nil)
			require.Equal(t, http.StatusOK, got.status, string(got.body))
			validateAgainstSpec(t, req, got)
		})
	}
}

// A populated board, so the dashboard and refresh answers carry real pull
// requests, issues and repos rather than empty lists.
func populatedBoard(t *testing.T) (*httptest.Server, *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	now := time.Now().UTC()
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{
				Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, Title: "Add a thing",
				URL: "https://github.com/alrayyes/a/pull/5", Author: "alice", Behind: true,
				MergeStatus: dashboard.MergeUnstable, CI: dashboard.CIFailure,
				Labels: []dashboard.Label{{Name: "bug", Color: "d73a4a"}}, RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
			},
			{
				Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 6, Title: "Bump a dependency",
				URL: "https://github.com/alrayyes/a/pull/6", Author: "dependabot[bot]", Draft: true,
				MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess, Labels: []dashboard.Label{}, RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
			},
		},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "Dependency Dashboard", URL: "https://github.com/alrayyes/a/issues/1", Author: "renovate[bot]", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Title: "A real bug", URL: "https://github.com/alrayyes/a/issues/2", Author: "alice", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now},
		},
		repos: []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", URL: "https://github.com/alrayyes/a"}},
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")["pullRequests"].([]any)

		return len(prs) == 2
	}, time.Second, 10*time.Millisecond)

	return srv, cookie
}

func TestContract_DashboardAndRefresh(t *testing.T) {
	t.Parallel()

	srv, cookie := populatedBoard(t)

	t.Run("GET /api/dashboard", func(t *testing.T) {
		t.Parallel()

		req, got := record(t, http.MethodGet, srv.URL+"/api/dashboard?includeDrafts=true", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
	})
	t.Run("POST /api/dashboard/refresh", func(t *testing.T) {
		t.Parallel()

		req, got := record(t, http.MethodPost, srv.URL+"/api/dashboard/refresh", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		// The second call lands inside the cooldown: same 200, plus the
		// Retry-After header the spec documents.
		req, got = record(t, http.MethodPost, srv.URL+"/api/dashboard/refresh", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		require.NotEmpty(t, got.header.Get("Retry-After"))
		validateAgainstSpec(t, req, got)
	})
}
