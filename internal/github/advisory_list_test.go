package github_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fullAlert(number int, severity, created string) map[string]any {
	return map[string]any{
		"number": number, "state": "open", "created_at": created,
		"html_url": "https://github.com/alrayyes/a/security/dependabot/1",
		"dependency": map[string]any{
			"package":       map[string]any{"ecosystem": "pip", "name": "certifi"},
			"manifest_path": "uv.lock", "scope": "runtime", "relationship": "direct",
		},
		"security_advisory": map[string]any{
			"ghsa_id": "GHSA-6q48-6c7w-9gw2", "cve_id": "CVE-2026-28194", "summary": "certifi bundles a bad CA",
			"description": "The package **certifi** is affected.", "severity": severity,
			"cvss":       map[string]any{"score": 9.1, "vector_string": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N"},
			"cwes":       []map[string]any{{"cwe_id": "CWE-295", "name": "Improper Certificate Validation"}},
			"epss":       map[string]any{"percentage": 0.0084, "percentile": 0.78},
			"references": []map[string]any{{"url": "https://nvd.nist.gov/vuln/detail/CVE-2026-28194"}},
		},
		"security_vulnerability": map[string]any{
			"vulnerable_version_range": ">= 2019.03.09, < 2026.10.19",
			"first_patched_version":    map[string]any{"identifier": "2026.10.19"},
		},
	}
}

func TestListAdvisories_ReadsEveryFieldTheDialogShows(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{fullAlert(7, "critical", "2026-10-21T14:12:00Z")})
	})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.Equal(t, "https://github.com/alrayyes/a/security/dependabot", got.URL)
	require.Len(t, got.Advisories, 1)
	assert.Equal(t, dashboard.AdvisoryItem{
		Number: 7, State: "open", Severity: dashboard.SeverityCritical, Summary: "certifi bundles a bad CA",
		GHSAID: "GHSA-6q48-6c7w-9gw2", CVEID: "CVE-2026-28194",
		Package: "certifi", Ecosystem: "pip", Scope: "runtime", Relationship: "direct", ManifestPath: "uv.lock",
		OpenedAt: "2026-10-21T14:12:00Z", VulnerableVersions: ">= 2019.03.09, < 2026.10.19", PatchedVersion: "2026.10.19",
		CVSS:        &dashboard.AdvisoryCVSS{Score: 9.1, Vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N"},
		Weaknesses:  []dashboard.AdvisoryWeakness{{ID: "CWE-295", Name: "Improper Certificate Validation"}},
		Description: "The package **certifi** is affected.",
		References:  []string{"https://nvd.nist.gov/vuln/detail/CVE-2026-28194"},
		EPSS:        &dashboard.AdvisoryEPSS{Percentage: 0.0084, Percentile: 0.78},
		URL:         "https://github.com/alrayyes/a/security/dependabot/1",
	}, got.Advisories[0])
}

func TestListAdvisories_SortsBySeverityThenNewestFirst(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{
			fullAlert(1, "low", "2026-10-22T00:00:00Z"),
			fullAlert(2, "high", "2026-10-01T00:00:00Z"),
			fullAlert(3, "critical", "2026-09-01T00:00:00Z"),
			fullAlert(4, "high", "2026-10-10T00:00:00Z"),
		})
	})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	var order []int
	for _, a := range got.Advisories {
		order = append(order, a.Number)
	}
	assert.Equal(t, []int{3, 4, 2, 1}, order)
}

func TestListAdvisories_NoneOpenIsKnownAndEmpty(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []map[string]any{}) })

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.NotNil(t, got.Advisories)
	assert.Empty(t, got.Advisories)
	assert.Empty(t, got.URL)
}

func TestListAdvisories_RefusalsAreUnknownWithTheirCause(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		status int
		reason dashboard.AdvisoryReason
	}{
		"a missing permission": {http.StatusForbidden, dashboard.ReasonRefused},
		"alerts switched off":  {http.StatusNotFound, dashboard.ReasonSwitchedOff},
		"a server error":       {http.StatusBadGateway, dashboard.ReasonFailed},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				writeJSON(t, w, map[string]any{"message": "nope"})
			})

			got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

			require.NoError(t, err)
			assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
			assert.Equal(t, tc.reason, got.Reason)
			assert.Empty(t, got.Advisories)
		})
	}
}

func TestListAdvisories_ScoresFromCVSS3Or4WhenTheTopLevelOneIsEmpty(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		a := fullAlert(1, "critical", "2026-10-22T13:02:20Z")
		adv, _ := a["security_advisory"].(map[string]any)
		adv["cvss"] = map[string]any{"score": 0.0, "vector_string": nil}
		adv["epss"] = nil
		adv["cvss_severities"] = map[string]any{
			"cvss_v3": map[string]any{"score": 0.0, "vector_string": nil},
			"cvss_v4": map[string]any{"score": 9.1, "vector_string": "CVSS:4.0/AV:N/AC:H/AT:P/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N"},
		}
		writeJSON(t, w, []map[string]any{a})
	})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, got.Advisories, 1)
	assert.Equal(t, &dashboard.AdvisoryCVSS{Score: 9.1, Vector: "CVSS:4.0/AV:N/AC:H/AT:P/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N"}, got.Advisories[0].CVSS)
	assert.Nil(t, got.Advisories[0].EPSS)
}

func TestListAdvisories_EveryPageHavingANextIsUnknownNotAShortList(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", `<https://api.github.com/repos/alrayyes/a/dependabot/alerts?after=more>; rel="next"`)
		writeJSON(t, w, []map[string]any{fullAlert(1, "high", "2026-10-22T00:00:00Z")})
	})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Equal(t, dashboard.ReasonTooMany, got.Reason)
	assert.Empty(t, got.Advisories)
}

func TestListAdvisories_KeepsAScoreWhenNoCVSSBlockHasAVector(t *testing.T) {
	t.Parallel()

	client := advisoryClient(t, func(w http.ResponseWriter, _ *http.Request) {
		a := fullAlert(1, "high", "2026-10-22T13:02:20Z")
		adv, _ := a["security_advisory"].(map[string]any)
		adv["cvss"] = map[string]any{"score": 7.5, "vector_string": nil}
		writeJSON(t, w, []map[string]any{a})
	})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, got.Advisories, 1)
	assert.Equal(t, &dashboard.AdvisoryCVSS{Score: 7.5}, got.Advisories[0].CVSS)
}

// countingForge serves one repo's alerts and counts how often it is asked.
type countingForge struct {
	alertReads   atomic.Int64
	failAlerts   atomic.Bool
	refuseAlerts atomic.Bool
}

func (f *countingForge) client(t *testing.T) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"viewer": map[string]any{"repositories": map[string]any{
			"pageInfo": map[string]any{"hasNextPage": false},
			"nodes":    []map[string]any{repoNodeWithOwnerName()},
		}}}})
	})
	mux.HandleFunc("/repos/alrayyes/a/dependabot/alerts", func(w http.ResponseWriter, _ *http.Request) {
		f.alertReads.Add(1)
		if f.refuseAlerts.Load() {
			w.WriteHeader(http.StatusForbidden)
			writeJSON(t, w, map[string]any{"message": "nope"})

			return
		}
		if f.failAlerts.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)

			return
		}
		writeJSON(t, w, []map[string]any{fullAlert(7, "critical", "2026-10-21T14:12:00Z"), fullAlert(8, "low", "2026-10-22T14:12:00Z")})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestListAdvisories_AfterARowRefreshCostsNoForgeCall(t *testing.T) {
	t.Parallel()
	forge := &countingForge{}
	client := forge.client(t)

	result := client.Fetch(t.Context())
	require.Len(t, result.MainBranches, 1)
	row := result.MainBranches[0].Advisories
	require.NotNil(t, row)
	require.Equal(t, 2, row.Count)
	require.EqualValues(t, 1, forge.alertReads.Load(), "the row's own read")

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.EqualValues(t, 1, forge.alertReads.Load(), "opening the dialog adds no read")
	require.Len(t, got.Advisories, 2)
	assert.Equal(t, "critical", string(got.Advisories[0].Severity))
	assert.NotEmpty(t, got.ReadAt)
	assert.Equal(t, got.ReadAt, row.ListReadAt, "the row says the list is ready, and when it was read")
}

func TestListAdvisories_OpensWithinTheWindowShareOneRead(t *testing.T) {
	t.Parallel()
	forge := &countingForge{}
	client := forge.client(t)

	for range 3 {
		_, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
		require.NoError(t, err)
	}

	assert.EqualValues(t, 1, forge.alertReads.Load())
}

func TestListAdvisories_RefreshReadsAgainAndAFailureKeepsTheLastGoodList(t *testing.T) {
	t.Parallel()
	forge := &countingForge{}
	client := forge.client(t)
	first, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	forge.failAlerts.Store(true)

	got, err := client.ListAdvisories(dashboard.WithFreshAdvisories(t.Context()), "alrayyes", "a")

	require.NoError(t, err)
	assert.EqualValues(t, 2, forge.alertReads.Load())
	assert.Equal(t, dashboard.ReasonFailed, got.RefreshFailed)
	assert.Len(t, got.Advisories, 2, "never an empty list")
	assert.Equal(t, first.ReadAt, got.ReadAt)
}

func TestListAdvisories_AfterARowThatGitHubRefusedCostsNoForgeCall(t *testing.T) {
	t.Parallel()
	forge := &countingForge{}
	forge.refuseAlerts.Store(true)
	client := forge.client(t)
	result := client.Fetch(t.Context())
	require.Len(t, result.MainBranches, 1)
	row := result.MainBranches[0].Advisories
	require.NotNil(t, row)
	require.Equal(t, dashboard.ReasonRefused, row.Reason)
	afterRow := forge.alertReads.Load()

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.ReasonRefused, got.Reason)
	assert.Equal(t, afterRow, forge.alertReads.Load(), "the refusal is kept, so the open asks nothing")
	assert.Equal(t, got.ReadAt, row.ListReadAt)
}

func TestListAdvisories_ASharedCacheServesOneCredentialsListToThatCredentialOnly(t *testing.T) {
	t.Parallel()
	forge := &countingForge{}
	shared := github.NewAdvisoryCache()
	open := func(credential string) *github.Client {
		c := forge.client(t)
		c.ShareAdvisoryCache(shared)
		c.SetStats(nil, credential)

		return c
	}

	_, err := open("token:aaaa").ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	_, err = open("token:aaaa").ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	require.EqualValues(t, 1, forge.alertReads.Load(), "the same credential reuses the list")

	_, err = open("app:7").ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)

	assert.EqualValues(t, 2, forge.alertReads.Load(), "another credential reads for itself")
}
