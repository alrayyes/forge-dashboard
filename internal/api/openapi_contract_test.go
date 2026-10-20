package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/legacy"
	"github.com/stretchr/testify/assert"
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

// autoMergingPR is the pull request on the populated board that has auto-merge
// on, held by the forge (#1608).
const autoMergingPR = 7

// autoMergeOffPR is the pull request on the populated board that reports
// autoMergeEnabled: false explicitly, as opposed to leaving it unknown.
const autoMergeOffPR = 8

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
			{
				Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: autoMergingPR, Title: "Ship it once green",
				URL: "https://github.com/alrayyes/a/pull/7", Author: "alice",
				MergeStatus: dashboard.MergeMergeable, CI: dashboard.CIPending, Labels: []dashboard.Label{}, RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
				AutoMergeEnabled: new(true), AutoMergeHeldBy: dashboard.AutoMergeHeldByForge,
			},
			{
				Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: autoMergeOffPR, Title: "Auto-merge switched off",
				URL: "https://github.com/alrayyes/a/pull/8", Author: "alice",
				MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess, Labels: []dashboard.Label{}, RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
				AutoMergeEnabled: new(false),
			},
		},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "Dependency Dashboard", URL: "https://github.com/alrayyes/a/issues/1", Author: "renovate[bot]", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Title: "A real bug", URL: "https://github.com/alrayyes/a/issues/2", Author: "alice", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now},
		},
		repos: []dashboard.Repo{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", URL: "https://github.com/alrayyes/a", LogoURL: "https://repository-images.githubusercontent.com/123/abc"},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/b", URL: "https://github.com/alrayyes/b"},
		},
		branches: contractBranches(now),
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

		return len(prs) == 4
	}, time.Second, 10*time.Millisecond)

	return srv, cookie
}

// contractBranches is one default-branch row of each shape the spec describes:
// a failed one with every field, a running one, an empty repo with no commit
// and a stale one.
func contractBranches(now time.Time) []dashboard.MainBranch {
	seconds := 270
	stale := now.Add(-time.Hour)

	return []dashboard.MainBranch{
		{
			Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", URL: "https://github.com/alrayyes/a", Branch: "main",
			Status: dashboard.MainBranchFailed, FailingJobs: []string{"test"}, RunURL: "https://github.com/alrayyes/a/actions/runs/1",
			Commit:     &dashboard.MainBranchCommit{SHA: "0123456", Subject: "fix: stop the thing", Author: "alrayyes", CommittedAt: &now},
			FinishedAt: &now, DurationSeconds: &seconds,
		},
		{
			Forge: dashboard.ForgeGitHub, FullName: "alrayyes/b", URL: "https://github.com/alrayyes/b", Branch: "main",
			Status: dashboard.MainBranchRunning, FailingJobs: []string{}, RunURL: "https://github.com/alrayyes/b",
			Commit: &dashboard.MainBranchCommit{SHA: "89abcde", Subject: "feat: add it", Author: "bob"},
		},
		{
			Forge: dashboard.ForgeGitHub, FullName: "alrayyes/empty", URL: "https://github.com/alrayyes/empty",
			Status: dashboard.MainBranchNone, FailingJobs: []string{}, RunURL: "https://github.com/alrayyes/empty",
		},
		{
			Forge: dashboard.ForgeGitHub, FullName: "alrayyes/old", URL: "https://github.com/alrayyes/old", Branch: "main",
			Status: dashboard.MainBranchPassed, FailingJobs: []string{}, RunURL: "https://github.com/alrayyes/old", StaleSince: &stale,
		},
	}
}

func TestContract_MainBranches(t *testing.T) {
	t.Parallel()

	srv, cookie := populatedBoard(t)

	req, got := record(t, http.MethodGet, srv.URL+"/api/main-branches", cookie)
	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)

	t.Run("without a session", func(t *testing.T) {
		t.Parallel()

		req, got := record(t, http.MethodGet, srv.URL+"/api/main-branches", nil)
		require.Equal(t, http.StatusUnauthorized, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
	})
}

func TestContract_DashboardAndRefresh(t *testing.T) {
	t.Parallel()

	srv, cookie := populatedBoard(t)

	t.Run("GET /api/dashboard", func(t *testing.T) {
		t.Parallel()

		req, got := record(t, http.MethodGet, srv.URL+"/api/dashboard?includeDrafts=true", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
		require.Contains(t, string(got.body), `"firstRefreshDone":true`, "required by the spec (#1673)")
		require.Contains(t, string(got.body), `"logoUrl":"https://repository-images.githubusercontent.com/123/abc"`, "a repository's own logo is on the wire")
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

// TestContract_IssueSettings records the settings calls that carry the issue
// settings (#1630), and a dashboard that applied them, against the spec.
func TestContract_IssueSettings(t *testing.T) {
	t.Parallel()

	srv, cookie := populatedBoard(t)
	send := func(method, path, body string) (*http.Request, recorded) {
		t.Helper()

		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.AddCookie(cookie)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		respBody, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		// kin-openapi reads the request body to validate it; give it its own copy.
		req.Body = nil

		return req, recorded{status: resp.StatusCode, header: resp.Header, body: respBody}
	}

	t.Run("PUT /api/settings with both settings", func(t *testing.T) {
		req, got := send(http.MethodPut, "/api/settings", `{"githubToken":"sekrit-token","hideDependencyDashboard":true,"ignoredTitles":["^Weekly report"]}`)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
		require.Contains(t, string(got.body), `"ignoredTitleCounts":[`, "one entry per pattern, null while unknown")
	})
	t.Run("GET /api/settings", func(t *testing.T) {
		req, got := send(http.MethodGet, "/api/settings", "")
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
		require.Contains(t, string(got.body), `"ignoredTitleCounts":[`)
	})
	t.Run("GET /api/dashboard with the settings applied", func(t *testing.T) {
		req, got := send(http.MethodGet, "/api/dashboard", "")
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
		require.Contains(t, string(got.body), `"settingsHiddenIssueCount":1`)
		require.Contains(t, string(got.body), `"hideDependencyDashboard":true`)
		require.Contains(t, string(got.body), `"ignoredTitlesSet":true`)
	})
	t.Run("PUT /api/settings with a pattern that does not compile", func(t *testing.T) {
		req, got := send(http.MethodPut, "/api/settings", `{"ignoredTitles":["("]}`)
		require.Equal(t, http.StatusBadRequest, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
	})
}

// kin-openapi doesn't check membership for x-extensible-enum, so the schema
// check alone passes any string. The second subtest holds the real response
// to the list the spec declares for autoMergeHeldBy (#1608).
func TestContract_DashboardCarriesAutoMergeHeldBy(t *testing.T) {
	t.Parallel()

	srv, cookie := populatedBoard(t)
	req, got := record(t, http.MethodGet, srv.URL+"/api/dashboard?includeDrafts=true", cookie)
	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)

	var body struct {
		PullRequests []map[string]any `json:"pullRequests"`
	}
	require.NoError(t, json.Unmarshal(got.body, &body))
	var pr map[string]any
	for _, p := range body.PullRequests {
		if p["number"] == float64(autoMergingPR) {
			pr = p
		}
	}
	require.NotNil(t, pr, "the auto-merging pull request is missing from the response")

	t.Run("auto-merge is on", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, true, pr["autoMergeEnabled"])
	})
	t.Run("autoMergeHeldBy is one of the values the spec lists", func(t *testing.T) {
		t.Parallel()

		doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
		require.NoError(t, err)
		prop := doc.Components.Schemas["PullRequest"].Value.Properties["autoMergeHeldBy"].Value

		assert.Contains(t, extensibleEnum(t, prop), pr["autoMergeHeldBy"])
	})
	t.Run("a pull request without auto-merge omits autoMergeHeldBy", func(t *testing.T) {
		t.Parallel()

		for _, p := range body.PullRequests {
			if p["number"] != float64(autoMergingPR) {
				assert.NotContains(t, p, "autoMergeHeldBy")
			}
		}
	})
	t.Run("a pull request with auto-merge off reports false and omits autoMergeHeldBy", func(t *testing.T) {
		t.Parallel()

		var off map[string]any
		for _, p := range body.PullRequests {
			if p["number"] == float64(autoMergeOffPR) {
				off = p
			}
		}
		require.NotNil(t, off, "the auto-merge-off pull request is missing from the response")
		assert.Equal(t, false, off["autoMergeEnabled"])
		assert.NotContains(t, off, "autoMergeHeldBy")
	})
}
