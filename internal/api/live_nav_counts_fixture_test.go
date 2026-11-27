package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/require"
)

// liveNavCountsFixturePath is read by the page's tests, which check that moving
// a pull request between the menu numbers from its live jobs ends where the
// server would have counted it (#5123), and by internal/github, which checks
// each case's CI reading against the rollup rule.
const liveNavCountsFixturePath = "../../tests/generated/live-nav-counts.json"

type liveJob struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion,omitempty"`
	URL        string `json:"url"`
}

// liveFacts is what the page reads of a served pull request to say where the
// snapshot counted it.
type liveFacts struct {
	Forge           string `json:"forge"`
	Repo            string `json:"repo"`
	Number          int    `json:"number"`
	Kind            string `json:"kind"`
	CI              string `json:"ci"`
	Draft           bool   `json:"draft"`
	Hidden          bool   `json:"hidden"`
	FailingCI       bool   `json:"failingCi"`
	OutOfDate       bool   `json:"outOfDate"`
	GreenBehindBase bool   `json:"greenBehindBase"`
}

type liveVariant struct {
	Variant      string    `json:"variant"`
	PullRequest  liveFacts `json:"pullRequest"`
	PullRequests pageCount `json:"pullRequests"`
	Releases     pageCount `json:"releases"`
	Bots         pageCount `json:"bots"`
}

type liveCase struct {
	Name string `json:"name"`
	// Jobs is the GitHub job list, and Rollup the state GitHub rolls it up to.
	// Empty means the commit has no rollup.
	Jobs                   []liveJob          `json:"jobs"`
	Rollup                 string             `json:"rollup"`
	CI                     dashboard.CIStatus `json:"ci"`
	FailingOnlyForApproval bool               `json:"failingOnlyForApproval"`
	Variants               []liveVariant      `json:"variants"`
}

// liveCases says how GitHub's jobs read. internal/github fails when its rollup
// rule reads one differently.
func liveCases() []liveCase {
	job := func(name, status, conclusion string) liveJob {
		return liveJob{Name: name, Status: status, Conclusion: conclusion, URL: "https://example.com/" + name}
	}
	done := func(conclusion string) liveJob { return job(conclusion, "completed", conclusion) }
	running := job("running", "in_progress", "")
	held := done("action_required")

	of := func(name, rollup string, ci dashboard.CIStatus, onlyApproval bool, jobs ...liveJob) liveCase {
		return liveCase{Name: name, Jobs: jobs, Rollup: rollup, CI: ci, FailingOnlyForApproval: onlyApproval}
	}

	return []liveCase{
		of("no jobs", "", dashboard.CINone, false),
		of("running", "PENDING", dashboard.CIPending, false, running),
		of("passed", "SUCCESS", dashboard.CISuccess, false, done("success"), done("skipped")),
		of("failed", "FAILURE", dashboard.CIFailure, false, done("failure")),
		of("timed out", "FAILURE", dashboard.CIFailure, false, done("timed_out")),
		of("cancelled", "FAILURE", dashboard.CICancelled, false, done("success"), done("cancelled")),
		of("failed and cancelled", "FAILURE", dashboard.CIFailure, false, done("failure"), done("cancelled")),
		of("held", "FAILURE", dashboard.CIFailure, true, held),
		of("held and running", "FAILURE", dashboard.CIFailure, true, held, running),
		of("held and passed", "FAILURE", dashboard.CIFailure, true, held, done("success")),
		of("held and failed", "FAILURE", dashboard.CIFailure, false, held, done("failure")),
		of("held and timed out", "FAILURE", dashboard.CIFailure, false, held, done("timed_out")),
		of("held and startup failure", "FAILURE", dashboard.CIFailure, false, held, done("startup_failure")),
		of("held and stale", "FAILURE", dashboard.CIFailure, false, held, done("stale")),
		of("held and cancelled", "FAILURE", dashboard.CIFailure, false, held, done("cancelled")),
	}
}

// liveVariants is one case on each page a pull request can be counted on, and
// the two the menu leaves out.
func liveVariants(t *testing.T, c liveCase) []liveVariant {
	t.Helper()

	variants := []struct {
		name          string
		kind          dashboard.PullRequestKind
		behind        bool
		draft, hidden bool
	}{
		{name: "regular", kind: dashboard.KindRegular},
		{name: "release", kind: dashboard.KindRelease},
		{name: "bot", kind: dashboard.KindDependency},
		{name: "bot behind", kind: dashboard.KindDependency, behind: true},
		{name: "draft", kind: dashboard.KindRegular, draft: true},
		{name: "hidden", kind: dashboard.KindRegular, hidden: true},
	}

	at := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	out := make([]liveVariant, 0, len(variants))
	for _, v := range variants {
		pr := dashboard.PullRequest{
			Forge: dashboard.ForgeGitHub, Repo: "acme/app", Number: 1, URL: "https://example.com/1",
			CI: c.CI, FailingOnlyForApproval: c.FailingOnlyForApproval,
			Draft: v.draft, Behind: v.behind, CreatedAt: at, UpdatedAt: at,
		}
		views, _, _ := boardSettings{now: at}.pullRequestViews([]dashboard.PullRequest{pr}, boardView{includeDrafts: true})
		require.Len(t, views, 1)
		view := views[0]
		view.Kind, view.Hidden = v.kind, v.hidden
		view.GreenBehindBase = view.countsAsBehind()

		raw, err := json.Marshal(view)
		require.NoError(t, err)
		var facts liveFacts
		require.NoError(t, json.Unmarshal(raw, &facts))

		counts := buildNavCounts([]pullRequestView{view}, 0)
		out = append(out, liveVariant{
			Variant: v.name, PullRequest: facts,
			PullRequests: counts.PullRequests, Releases: counts.Releases, Bots: counts.Bots,
		})
	}

	return out
}

func buildLiveNavCountsFixture(t *testing.T) []byte {
	t.Helper()

	cases := liveCases()
	for i := range cases {
		if cases[i].Jobs == nil {
			cases[i].Jobs = []liveJob{}
		}
		cases[i].Variants = liveVariants(t, cases[i])
	}
	file := struct {
		Note  string     `json:"note"`
		Cases []liveCase `json:"cases"`
	}{
		Note: "Generated by internal/api/live_nav_counts_fixture_test.go from buildNavCounts. Do not edit: run " +
			"UPDATE_FIXTURES=1 go test ./internal/api -run TestLiveNavCountsFixture.",
		Cases: cases,
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	require.NoError(t, enc.Encode(file))

	return buf.Bytes()
}

// The page sorts a live CI state into the menu numbers as buildNavCounts sorts
// the snapshot's. A change to either fails against this file.
func TestLiveNavCountsFixture_IsCurrent(t *testing.T) {
	t.Parallel()

	want := buildLiveNavCountsFixture(t)
	path := filepath.Clean(liveNavCountsFixturePath)

	if os.Getenv("UPDATE_FIXTURES") != "" {
		require.NoError(t, os.WriteFile(path, want, 0o600))

		return
	}

	got, err := os.ReadFile(path)
	require.NoError(t, err, "the fixture is missing: run UPDATE_FIXTURES=1 go test ./internal/api -run TestLiveNavCountsFixture")
	require.True(t, bytes.Equal(want, got),
		"tests/generated/live-nav-counts.json is stale: run UPDATE_FIXTURES=1 go test ./internal/api -run TestLiveNavCountsFixture and commit the result")
}
