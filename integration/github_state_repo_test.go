//go:build ghfixture

// The repo-level half of the GitHub comparison (#950): settings that change
// what GitHub accepts, rather than a state a pull request is in. Each test
// opens its own pull request, flips a setting on the fixture repo, and puts
// it back when done, so none of this leans on the pull requests build.sh
// makes. They change the fixture repo's settings, so they don't run in
// parallel with each other.
package integration

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const fixtureSlug = fixtureOwner + "/" + fixtureRepo

// ghAPI calls the GitHub REST API through gh and decodes the answer into out
// (when not nil). body, when not nil, is sent as the JSON request body.
func ghAPI(t *testing.T, method, path string, body, out any) error {
	t.Helper()
	args := []string{"api", "-X", method, path}
	cmd := exec.Command("gh", args...)
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		cmd.Args = append(cmd.Args, "--input", "-")
		cmd.Stdin = bytes.NewReader(raw)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("gh api %s %s: %w: %s", method, path, err, stderr.String())
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}

	return nil
}

// fixtureSettings are the repo settings these tests flip.
type fixtureSettings struct {
	AllowMergeCommit bool `json:"allow_merge_commit"`
	AllowSquashMerge bool `json:"allow_squash_merge"`
	AllowRebaseMerge bool `json:"allow_rebase_merge"`
	AllowAutoMerge   bool `json:"allow_auto_merge"`
}

// setSettings changes the fixture repo's merge settings and restores the
// ones it found when the test ends.
func setSettings(t *testing.T, want fixtureSettings) {
	t.Helper()
	var before fixtureSettings
	require.NoError(t, ghAPI(t, "GET", "repos/"+fixtureSlug, nil, &before))
	t.Cleanup(func() { assert.NoError(t, ghAPI(t, "PATCH", "repos/"+fixtureSlug, before, nil)) })
	require.NoError(t, ghAPI(t, "PATCH", "repos/"+fixtureSlug, want, nil))
}

// openPR makes a pull request of its own on base with one commit, plus the
// extra files, and closes it again when the test ends. It waits for GitHub to
// work out whether the pull request merges.
func openPR(t *testing.T, base, title string, extra map[string]string) int {
	t.Helper()
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	require.NoError(t, ghAPI(t, "GET", "repos/"+fixtureSlug+"/git/ref/heads/"+base, nil, &ref))
	branch := fmt.Sprintf("head/%s-%d", title, time.Now().UnixNano())
	require.NoError(t, ghAPI(t, "POST", "repos/"+fixtureSlug+"/git/refs", map[string]string{"ref": "refs/heads/" + branch, "sha": ref.Object.SHA}, nil))
	t.Cleanup(func() { _ = ghAPI(t, "DELETE", "repos/"+fixtureSlug+"/git/refs/heads/"+branch, nil, nil) })

	files := map[string]string{"changes/" + title + ".txt": title + "\n"}
	for k, v := range extra {
		files[k] = v
	}
	for path, content := range files {
		put := map[string]string{"message": "test: " + title, "content": base64.StdEncoding.EncodeToString([]byte(content)), "branch": branch}
		var existing struct {
			SHA string `json:"sha"`
		}
		if ghAPI(t, "GET", "repos/"+fixtureSlug+"/contents/"+path+"?ref="+branch, nil, &existing) == nil {
			put["sha"] = existing.SHA
		}
		require.NoError(t, ghAPI(t, "PUT", "repos/"+fixtureSlug+"/contents/"+path, put, nil))
	}

	var pr struct {
		Number int `json:"number"`
	}
	require.NoError(t, ghAPI(t, "POST", "repos/"+fixtureSlug+"/pulls", map[string]string{"title": title, "head": branch, "base": base, "body": "Opened by the fixture test; closed when it ends."}, &pr))
	t.Cleanup(func() {
		_ = ghAPI(t, "PATCH", fmt.Sprintf("repos/%s/pulls/%d", fixtureSlug, pr.Number), map[string]string{"state": "closed"}, nil)
	})
	require.Eventually(t, func() bool {
		var p struct {
			Mergeable *bool `json:"mergeable"`
		}
		return ghAPI(t, "GET", fmt.Sprintf("repos/%s/pulls/%d", fixtureSlug, pr.Number), nil, &p) == nil && p.Mergeable != nil
	}, 60*time.Second, 2*time.Second, "GitHub never worked out whether #%d merges", pr.Number)

	return pr.Number
}

// mergeShape says how a merged pull request landed.
func mergeShape(t *testing.T, number int, title string) string {
	t.Helper()
	var pr struct {
		Merged         bool   `json:"merged"`
		MergeCommitSHA string `json:"merge_commit_sha"`
	}
	require.NoError(t, ghAPI(t, "GET", fmt.Sprintf("repos/%s/pulls/%d", fixtureSlug, number), nil, &pr))
	require.True(t, pr.Merged, "#%d is not merged", number)
	var c struct {
		Parents []struct{} `json:"parents"`
		Commit  struct {
			Message string `json:"message"`
		} `json:"commit"`
	}
	require.NoError(t, ghAPI(t, "GET", "repos/"+fixtureSlug+"/commits/"+pr.MergeCommitSHA, nil, &c))
	subject, _, _ := strings.Cut(c.Commit.Message, "\n")
	switch {
	case len(c.Parents) == 2:
		return "merge"
	case strings.HasSuffix(subject, fmt.Sprintf("(#%d)", number)):
		return "squash"
	default:
		return "rebase"
	}
}

// Whichever merge methods the repo allows, the dashboard's Merge picks one
// GitHub accepts (#950). Merge commit, squash and rebase each as the only
// method on offer, then all three on a branch that requires linear history.
func TestGitHubState_MergeUsesAMethodTheRepoAllows(t *testing.T) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		t.Skip("GITHUB_TOKEN not set")
	}
	client := github.NewClient(token, "", "")

	cases := []struct {
		name      string
		settings  fixtureSettings
		base      string
		linear    bool   // base/linear requires linear history, for admins too
		known     string // ticket tracking a known failure, so the test passes until it is fixed
		wantShape string
	}{
		{"merge commit only", fixtureSettings{AllowMergeCommit: true, AllowAutoMerge: true}, "base/clean", false, "merge", ""},
		{"squash only", fixtureSettings{AllowSquashMerge: true, AllowAutoMerge: true}, "base/clean", false, "squash", ""},
		{"rebase only", fixtureSettings{AllowRebaseMerge: true, AllowAutoMerge: true}, "base/clean", false, "rebase", ""},
		{"all three on a linear-history branch", fixtureSettings{AllowMergeCommit: true, AllowSquashMerge: true, AllowRebaseMerge: true, AllowAutoMerge: true}, "base/linear", true, "squash", "https://github.com/alrayyes/forge-dashboard/issues/1173"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// GitHub refuses a merge-commit-only repo while any branch requires
			// linear history, so base/linear's rule follows the case.
			setLinearBase(t, tc.linear)
			setSettings(t, tc.settings)
			title := fmt.Sprintf("method-%d", time.Now().UnixNano())
			number := openPR(t, tc.base, title, nil)

			err := client.MergePullRequest(t.Context(), fixtureOwner, fixtureRepo, number)
			if tc.known != "" {
				require.Error(t, err, "now merges, remove the known ticket %s", tc.known)
				t.Logf("known, %s: %v", tc.known, err)

				return
			}
			require.NoError(t, err, "GitHub refused the method the dashboard picked")
			assert.Equal(t, tc.wantShape, mergeShape(t, number, title))
		})
	}
}

// setLinearBase sets base/linear's protection: linear history required, and
// when strict, enforced on admins too (otherwise the owner's token merges a
// merge commit through it). build.sh leaves it required and not enforced; the
// original comes back when the test ends.
func setLinearBase(t *testing.T, strict bool) {
	t.Helper()
	put := func(linear, enforce bool) error {
		return ghAPI(t, "PUT", "repos/"+fixtureSlug+"/branches/base/linear/protection", map[string]any{
			"required_status_checks": nil, "enforce_admins": enforce, "required_pull_request_reviews": nil,
			"restrictions": nil, "required_linear_history": linear,
		}, nil)
	}
	t.Cleanup(func() { assert.NoError(t, put(true, false)) })
	require.NoError(t, put(strict, strict))
}

// Turning auto-merge off for the repo takes "Enable auto-merge" away on
// GitHub, and the dashboard follows (#950). The pull request waits on a
// required check that never finishes, so auto-merge has something to wait for.
func TestGitHubState_AutoMergeFollowsTheRepoSetting(t *testing.T) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		t.Skip("GITHUB_TOKEN not set")
	}
	client := github.NewClient(token, "", "")
	title := fmt.Sprintf("automerge-%d", time.Now().UnixNano())

	settings := fixtureSettings{AllowMergeCommit: true, AllowSquashMerge: true, AllowRebaseMerge: true, AllowAutoMerge: true}
	setSettings(t, settings)
	number := openPR(t, "base/req-check", title, map[string]string{"ci/required.txt": "slow\n"})

	allowed := func() (github bool, dash *bool) {
		out, err := exec.Command("gh", "api", "graphql", "-f", fmt.Sprintf(`query=query { repository(owner:%q, name:%q) { pullRequest(number:%d) { viewerCanEnableAutoMerge } } }`, fixtureOwner, fixtureRepo, number), "--jq", ".data.repository.pullRequest.viewerCanEnableAutoMerge").Output()
		require.NoError(t, err)
		github = strings.TrimSpace(string(out)) == "true"
		prs, _, err := client.FetchRepo(t.Context(), fixtureOwner, fixtureRepo, fixtureSlug)
		require.NoError(t, err)
		for _, pr := range prs {
			if pr.Number == number {
				return github, pr.AutoMergeAllowed
			}
		}
		require.Fail(t, "the dashboard does not list the pull request", "#%d", number)

		return github, nil
	}

	t.Run("on", func(t *testing.T) {
		gh, dash := allowed()
		assert.True(t, gh, "GitHub should allow auto-merge")
		require.NotNil(t, dash)
		assert.True(t, *dash)
	})

	settings.AllowAutoMerge = false
	require.NoError(t, ghAPI(t, "PATCH", "repos/"+fixtureSlug, settings, nil))
	t.Run("off", func(t *testing.T) {
		gh, dash := allowed()
		assert.False(t, gh, "GitHub should refuse auto-merge")
		require.NotNil(t, dash)
		assert.False(t, *dash)
	})
}
