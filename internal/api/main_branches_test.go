package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mainBranchesBody is GET /api/main-branches as a client reads it.
type mainBranchesBody struct {
	Counts   dashboard.MainBranchCounts `json:"counts"`
	Branches []struct {
		FullName   string     `json:"fullName"`
		Status     string     `json:"status"`
		Stale      bool       `json:"stale"`
		StaleSince *time.Time `json:"staleSince"`
	} `json:"branches"`
}

// newMainBranchesServer serves rows from a GitHub source for a signed-in user.
func newMainBranchesServer(t *testing.T, rows []dashboard.MainBranch) (string, *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &fakeConfiguredSource{
		health:   dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: len(rows)},
		branches: rows,
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

	return srv.URL, cookie
}

// readMainBranchesFrom reads GET /api/main-branches until it lists want rows.
func readMainBranchesFrom(t *testing.T, srvURL string, cookie *http.Cookie, want int) mainBranchesBody {
	t.Helper()

	var body mainBranchesBody
	require.Eventually(t, func() bool {
		_, got := record(t, http.MethodGet, srvURL+"/api/main-branches", cookie)
		body = mainBranchesBody{}

		return got.status == http.StatusOK && json.Unmarshal(got.body, &body) == nil && len(body.Branches) == want
	}, 2*time.Second, 10*time.Millisecond)

	return body
}

// readMainBranches serves rows from a GitHub source and waits for the first
// refresh that carries them.
func readMainBranches(t *testing.T, rows []dashboard.MainBranch) mainBranchesBody {
	t.Helper()

	srvURL, cookie := newMainBranchesServer(t, rows)

	return readMainBranchesFrom(t, srvURL, cookie, len(rows))
}

// A repo ignored for pull requests leaves Branches, and its failing default
// branch leaves the nav badge with it: the page and the badge follow the same
// ignore list as the pull requests page (#1337).
func TestMainBranches_LeaveOutARepoIgnoredForPullRequests(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{
		branchRow("acme/kept", dashboard.MainBranchPassed),
		branchRow("acme/ignored", dashboard.MainBranchFailed),
	})
	readMainBranchesFrom(t, srvURL, cookie, 2)
	resp := postRepoIgnoreAction(t, srvURL, cookie, "acme/ignored", true, false)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	body := readMainBranchesFrom(t, srvURL, cookie, 1)

	require.Len(t, body.Branches, 1)
	assert.Equal(t, "acme/kept", body.Branches[0].FullName)
	assert.Equal(t, 1, body.Counts.Total)
	assert.Equal(t, 0, body.Counts.Failed)
	assert.Equal(t, map[string]any{"total": 1.0, "running": 0.0, "failed": 0.0, "passed": 1.0}, navCount(t, fetchDashboard(t, srvURL, cookie), "branches"),
		"the badge agrees with the page")
}

// Ignoring only a repo's issues leaves its branch alone: Branches follows the
// pull request ignore, not the issue one.
func TestMainBranches_KeepARepoIgnoredOnlyForIssues(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{branchRow("acme/kept", dashboard.MainBranchFailed)})
	readMainBranchesFrom(t, srvURL, cookie, 1)
	resp := postRepoIgnoreAction(t, srvURL, cookie, "acme/kept", false, true)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	body := readMainBranchesFrom(t, srvURL, cookie, 1)

	assert.Equal(t, 1, body.Counts.Failed)
	assert.Equal(t, map[string]any{"total": 1.0, "running": 0.0, "failed": 1.0, "passed": 0.0}, navCount(t, fetchDashboard(t, srvURL, cookie), "branches"))
}

func branchRow(repo string, status dashboard.MainBranchStatus) dashboard.MainBranch {
	return dashboard.MainBranch{Forge: dashboard.ForgeGitHub, FullName: repo, Branch: "main", Status: status, FailingJobs: []string{}}
}

func TestMainBranches(t *testing.T) {
	t.Parallel()

	rows := []dashboard.MainBranch{
		branchRow("o/passing", dashboard.MainBranchPassed),
		branchRow("o/none", dashboard.MainBranchNone),
		branchRow("o/broken", dashboard.MainBranchFailed),
		branchRow("o/building", dashboard.MainBranchRunning),
	}
	for i, hoursAgo := range map[int]int{0: 2, 2: 5, 3: 1} {
		c := time.Now().Add(-time.Duration(hoursAgo) * time.Hour).UTC()
		rows[i].Commit = &dashboard.MainBranchCommit{CommittedAt: &c}
	}
	stale := time.Now().Add(-time.Hour).UTC()
	rows[0].StaleSince = &stale
	body := readMainBranches(t, rows)

	t.Run("every row is listed, newest commit first, undated last", func(t *testing.T) {
		t.Parallel()

		var order []string
		for _, b := range body.Branches {
			order = append(order, b.FullName)
		}
		assert.Equal(t, []string{"o/building", "o/passing", "o/broken", "o/none"}, order)
	})

	t.Run("counts each status, so the pills match what they list", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, dashboard.MainBranchCounts{Failed: 1, Passed: 1, Running: 1, None: 1, Total: 4}, body.Counts)
	})

	t.Run("a row carried over from an earlier refresh is stale, with the time", func(t *testing.T) {
		t.Parallel()

		for _, b := range body.Branches {
			if b.FullName == "o/passing" {
				assert.True(t, b.Stale)
				require.NotNil(t, b.StaleSince)
				assert.WithinDuration(t, stale, *b.StaleSince, time.Second)
			} else {
				assert.False(t, b.Stale, b.FullName)
				assert.Nil(t, b.StaleSince, b.FullName)
			}
		}
	})
}

func TestMainBranches_NoRepos(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	_, got := record(t, http.MethodGet, srv.URL+"/api/main-branches", cookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	assert.JSONEq(t, `[]`, string(rawField(t, got.body, "branches")), "an array, never null")
	assert.JSONEq(t, `{"failed":0,"passed":0,"running":0,"none":0,"total":0}`, string(rawField(t, got.body, "counts")))
}

func rawField(t *testing.T, body []byte, name string) json.RawMessage {
	t.Helper()

	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(body, &fields))

	return fields[name]
}
