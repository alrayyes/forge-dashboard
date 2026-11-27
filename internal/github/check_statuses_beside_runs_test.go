package github_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// besideRuns is a forge whose commit cafef00d has check runs and commit
// statuses. rollupStatuses is what the GraphQL rollup counts as statuses.
type besideRuns struct {
	runs           []map[string]any
	statusPages    [][]map[string]any
	statusCode     int
	rollupStatuses []map[string]any

	statusReads atomic.Int32
}

func (f *besideRuns) serve(t *testing.T) *httptest.Server {
	t.Helper()

	rollup := func() map[string]any {
		return map[string]any{
			"state": "SUCCESS",
			"contexts": map[string]any{
				"checkRunCountsByState":      []map[string]any{{"state": "SUCCESS", "count": 1}},
				"statusContextCountsByState": f.rollupStatuses,
				"nodes":                      []map[string]any{},
			},
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": f.runs})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, r *http.Request) {
		f.statusReads.Add(1)
		if f.statusCode != 0 {
			w.WriteHeader(f.statusCode)

			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		page = max(page, 1)
		if page < len(f.statusPages) {
			w.Header().Set("Link", "<http://"+r.Host+r.URL.Path+"?page="+strconv.Itoa(page+1)+`>; rel="next"`)
		}
		var statuses []map[string]any
		if page <= len(f.statusPages) {
			statuses = f.statusPages[page-1]
		}
		writeJSON(t, w, map[string]any{"statuses": statuses})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		assert.NoError(t, err)
		if strings.Contains(string(body), "pullRequest(") {
			writeJSON(t, w, map[string]any{"data": map[string]any{"pr0": map[string]any{"pullRequest": map[string]any{
				"state": "OPEN", "number": 5, "mergeStateStatus": "CLEAN", "headRefOid": "cafef00d",
				"createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z",
				"commits": map[string]any{"nodes": []map[string]any{
					{"commit": map[string]any{"oid": "cafef00d", "statusCheckRollup": rollup()}},
				}},
			}}}})

			return
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{
			"url": "https://github.com/alrayyes/a",
			"defaultBranchRef": map[string]any{"target": map[string]any{
				"oid": "cafef00d", "statusCheckRollup": rollup(),
			}},
		}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func restRun(name, status, conclusion string) map[string]any {
	return map[string]any{
		"name": name, "status": status, "conclusion": conclusion,
		"html_url": "https://github.com/alrayyes/a/runs/" + name,
	}
}

func commitStatus(context, state string) map[string]any {
	return map[string]any{"context": context, "state": state, "target_url": "https://ci.example/" + context}
}

// namesAndStates is each check as "name state", in the order listed.
func namesAndStates(checks []dashboard.Check) []string {
	out := make([]string, 0, len(checks))
	for _, c := range checks {
		out = append(out, c.Name+" "+string(c.State))
	}

	return out
}

func TestListChecks_AStatusBesideCheckRunsIsListedWithItsStateAndLink(t *testing.T) {
	t.Parallel()

	forge := &besideRuns{
		runs:        []map[string]any{restRun("build", "completed", "success")},
		statusPages: [][]map[string]any{{commitStatus("deploy", "failure")}},
	}
	client := github.NewClient("test-token", "", forge.serve(t).URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Equal(t, []string{"build success", "deploy failure"}, namesAndStates(checks))
	assert.Equal(t, "https://ci.example/deploy", checks[1].URL)
}

func TestListDefaultBranchChecks_AStatusBesideCheckRunsIsListed(t *testing.T) {
	t.Parallel()

	forge := &besideRuns{
		runs:        []map[string]any{restRun("build", "completed", "success")},
		statusPages: [][]map[string]any{{commitStatus("deploy", "error")}},
	}
	client := github.NewClient("test-token", "", forge.serve(t).URL)

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.Equal(t, []string{"build success", "deploy failure"}, namesAndStates(checks))
}

func TestListChecks_AStatusAndACheckRunForTheSameJobAreListedOnce(t *testing.T) {
	t.Parallel()

	forge := &besideRuns{
		runs: []map[string]any{
			restRun("build", "completed", "success"),
			restRun("lint", "completed", "timed_out"),
			restRun("e2e", "queued", ""),
		},
		statusPages: [][]map[string]any{{
			commitStatus("build", "success"),
			commitStatus("lint", "failure"),
			commitStatus("e2e", "pending"),
		}},
	}
	client := github.NewClient("test-token", "", forge.serve(t).URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, []string{"build success", "lint timed_out", "e2e queued"}, namesAndStates(checks))
}

// The row counts both, so hiding one would hide a failure or a wait.
func TestListChecks_AStatusThatDisagreesWithItsNamesakeIsListedToo(t *testing.T) {
	t.Parallel()

	forge := &besideRuns{
		runs: []map[string]any{restRun("build", "completed", "success"), restRun("docs", "completed", "skipped")},
		statusPages: [][]map[string]any{{
			commitStatus("build", "failure"),
			commitStatus("docs", "success"),
		}},
	}
	client := github.NewClient("test-token", "", forge.serve(t).URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, []string{"build success", "docs skipped", "build failure", "docs success"}, namesAndStates(checks))
}

func TestListChecks_StatusesAreReadToTheLastPage(t *testing.T) {
	t.Parallel()

	for name, runs := range map[string][]map[string]any{
		"beside check runs": {restRun("build", "completed", "success")},
		"without any":       {},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			forge := &besideRuns{
				runs: runs,
				statusPages: [][]map[string]any{
					{commitStatus("first", "success")},
					{commitStatus("second", "failure")},
				},
			}
			client := github.NewClient("test-token", "", forge.serve(t).URL)

			checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Subset(t, namesAndStates(checks), []string{"first success", "second failure"})
			assert.EqualValues(t, 2, forge.statusReads.Load())
		})
	}
}

func TestListChecks_AFailedStatusReadKeepsTheCheckRuns(t *testing.T) {
	t.Parallel()

	forge := &besideRuns{
		runs:       []map[string]any{restRun("build", "completed", "success")},
		statusCode: http.StatusForbidden,
	}
	client := github.NewClient("test-token", "", forge.serve(t).URL)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, []string{"build success"}, namesAndStates(checks))
}

// readRow is one of the two reads that give a row its rollup.
var readRow = map[string]func(*testing.T, *github.Client){
	"pull request row": func(t *testing.T, c *github.Client) {
		t.Helper()
		_, err := c.RefreshPending(t.Context(), []dashboard.PullRequestRef{{
			Forge: dashboard.ForgeGitHub, Owner: "alrayyes", Name: "a", FullName: "alrayyes/a", Number: 5,
		}})
		require.NoError(t, err)
	},
	"default branch row": func(t *testing.T, c *github.Client) {
		t.Helper()
		_, err := c.FetchMainBranch(t.Context(), "alrayyes", "a", "alrayyes/a")
		require.NoError(t, err)
	},
}

func TestListChecks_NoStatusReadWhenTheRowCountedNone(t *testing.T) {
	t.Parallel()

	for name, read := range readRow {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			forge := &besideRuns{runs: []map[string]any{restRun("build", "completed", "success")}}
			url := forge.serve(t).URL
			// A source builds a client per request; only the cache is shared.
			seen := github.NewStatusPresenceCache()
			polling := github.NewClient("test-token", "", url)
			polling.ShareStatusPresenceCache(seen)
			read(t, polling)
			listing := github.NewClient("test-token", "", url)
			listing.ShareStatusPresenceCache(seen)

			checks, err := listing.ListChecks(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Len(t, checks, 1)
			assert.Zero(t, forge.statusReads.Load())
		})
	}
}

func TestListChecks_ReadsStatusesWhenTheRowCountedSome(t *testing.T) {
	t.Parallel()

	for name, read := range readRow {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			forge := &besideRuns{
				runs:           []map[string]any{restRun("build", "completed", "success")},
				statusPages:    [][]map[string]any{{commitStatus("deploy", "failure")}},
				rollupStatuses: []map[string]any{{"state": "FAILURE", "count": 1}},
			}
			client := github.NewClient("test-token", "", forge.serve(t).URL)
			read(t, client)

			checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Equal(t, []string{"build success", "deploy failure"}, namesAndStates(checks))
		})
	}
}

// A commit never loses a status, so a rollup without one, from a token that
// may not see them, does not undo a rollup that counted one.
func TestListChecks_ARollupWithoutStatusesDoesNotForgetOne(t *testing.T) {
	t.Parallel()

	forge := &besideRuns{
		runs:           []map[string]any{restRun("build", "completed", "success")},
		statusPages:    [][]map[string]any{{commitStatus("deploy", "failure")}},
		rollupStatuses: []map[string]any{{"state": "FAILURE", "count": 1}},
	}
	client := github.NewClient("test-token", "", forge.serve(t).URL)
	readRow["pull request row"](t, client)
	forge.rollupStatuses = nil
	readRow["pull request row"](t, client)

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Len(t, checks, 2)
}
