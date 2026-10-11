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

// readMainBranches serves rows from a GitHub source and waits for the first
// refresh that carries them.
func readMainBranches(t *testing.T, rows []dashboard.MainBranch) mainBranchesBody {
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

	var body mainBranchesBody
	require.Eventually(t, func() bool {
		_, got := record(t, http.MethodGet, srv.URL+"/api/main-branches", cookie)
		body = mainBranchesBody{}

		return got.status == http.StatusOK && json.Unmarshal(got.body, &body) == nil && len(body.Branches) == len(rows)
	}, 2*time.Second, 10*time.Millisecond)

	return body
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
	stale := time.Now().Add(-time.Hour).UTC()
	rows[0].StaleSince = &stale
	body := readMainBranches(t, rows)

	t.Run("every row is listed, failed first, then running, passed and none", func(t *testing.T) {
		t.Parallel()

		var order []string
		for _, b := range body.Branches {
			order = append(order, b.FullName)
		}
		assert.Equal(t, []string{"o/broken", "o/building", "o/passing", "o/none"}, order)
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
