//go:build integration

// Package integration holds the container/integration layer: real
// dependencies in containers, not mocks, per rules/go-test.md. It's a
// separate build tag from the unit suite because it needs a Docker daemon
// and takes real seconds to boot a Forgejo instance — CI runs it in its own
// job (see .github/workflows/ci.yml's container-integration job), not on
// every `go test ./...`.
package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/exec"
	"github.com/testcontainers/testcontainers-go/wait"
)

// startForgejo boots a real Forgejo instance with SQLite storage and the
// install wizard skipped — enough to drive the real REST API, nothing this
// test doesn't need.
func startForgejo(t *testing.T) (baseURL string, container testcontainers.Container) {
	t.Helper()
	ctx := t.Context()

	req := testcontainers.ContainerRequest{
		Image:        "data.forgejo.org/forgejo/forgejo:10.0.3@sha256:99b6c15a1bc98e623103a83a04023662a93fd035dac4f0a856d781afa9d71095",
		ExposedPorts: []string{"3000/tcp"},
		Env: map[string]string{
			"FORGEJO__database__DB_TYPE":      "sqlite3",
			"FORGEJO__security__INSTALL_LOCK": "true",
			"FORGEJO__server__DISABLE_SSH":    "true",
		},
		WaitingFor: wait.ForHTTP("/api/v1/version").WithPort("3000/tcp").WithStartupTimeout(90 * time.Second),
	}
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, container.Terminate(context.Background())) })

	host, err := container.Host(ctx)
	require.NoError(t, err)
	port, err := container.MappedPort(ctx, "3000")
	require.NoError(t, err)

	return fmt.Sprintf("http://%s:%s", host, port.Port()), container
}

// createAdminToken creates an admin user via the Forgejo CLI (there's no
// API for this without already having a token) and returns a personal
// access token for it.
func createAdminToken(t *testing.T, container testcontainers.Container) string {
	t.Helper()
	ctx := t.Context()

	exitCode, reader, err := container.Exec(ctx, []string{
		"forgejo", "admin", "user", "create",
		"--username", "testadmin", "--password", "TestPassw0rd1!",
		"--email", "admin@example.com", "--admin", "--must-change-password=false",
	}, exec.WithUser("git"), exec.Multiplexed())
	require.NoError(t, err)
	requireExecSucceeded(t, exitCode, reader)

	exitCode, reader, err = container.Exec(ctx, []string{
		"forgejo", "admin", "user", "generate-access-token",
		"--username", "testadmin", "--token-name", "integration", "--scopes", "all", "--raw",
	}, exec.WithUser("git"), exec.Multiplexed())
	require.NoError(t, err)
	requireExecSucceeded(t, exitCode, reader)

	var buf bytes.Buffer
	_, err = buf.ReadFrom(reader)
	require.NoError(t, err)
	return trimToken(buf.String())
}

func requireExecSucceeded(t *testing.T, exitCode int, _ interface{}) {
	t.Helper()
	require.Equal(t, 0, exitCode, "container command failed")
}

// trimToken strips the trailing newline testcontainers' multiplexed stream
// leaves on the token.
func trimToken(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

// forgejoFixture is a tiny hand-rolled client for setting up test data
// through the real API — deliberately not internal/forgejo.Client, so the
// fixture and the code under test never share a bug.
type forgejoFixture struct {
	baseURL string
	token   string
}

func (f *forgejoFixture) request(t *testing.T, method, path string, body any) map[string]any {
	t.Helper()

	return f.requestAs(t, "", method, path, body)
}

// requestAs is request acting as another user through the admin token's
// Sudo header, which is how the fixture gets a second account to review a
// pull request its author can't review themselves.
func (f *forgejoFixture) requestAs(t *testing.T, sudo, method, path string, body any) map[string]any {
	t.Helper()
	var reqBody bytes.Buffer
	if body != nil {
		require.NoError(t, json.NewEncoder(&reqBody).Encode(body))
	}
	req, err := http.NewRequestWithContext(t.Context(), method, f.baseURL+"/api/v1"+path, &reqBody)
	require.NoError(t, err)
	req.Header.Set("Authorization", "token "+f.token)
	req.Header.Set("Content-Type", "application/json")
	if sudo != "" {
		req.Header.Set("Sudo", sudo)
	}

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Less(t, resp.StatusCode, 300, "request to %s failed", path)

	// Most endpoints answer with an object, but a few (requested_reviewers)
	// answer with an array, which callers don't read.
	var decoded any
	if resp.StatusCode != http.StatusNoContent {
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&decoded))
	}
	out, _ := decoded.(map[string]any)

	return out
}

func (f *forgejoFixture) createRepo(t *testing.T, name string) {
	t.Helper()
	f.request(t, http.MethodPost, "/user/repos", map[string]any{
		"name": name, "auto_init": true, "default_branch": "main",
	})
}

func (f *forgejoFixture) archiveRepo(t *testing.T, owner, repo string) {
	t.Helper()
	f.request(t, http.MethodPatch, fmt.Sprintf("/repos/%s/%s", owner, repo), map[string]any{
		"archived": true,
	})
}

func (f *forgejoFixture) createIssue(t *testing.T, owner, repo, title string, labelIDs ...int) {
	t.Helper()
	body := map[string]any{"title": title}
	if len(labelIDs) > 0 {
		body["labels"] = labelIDs
	}
	f.request(t, http.MethodPost, fmt.Sprintf("/repos/%s/%s/issues", owner, repo), body)
}

// createLabel returns the real label ID Forgejo assigned, needed to
// attach it to an issue at creation time.
func (f *forgejoFixture) createLabel(t *testing.T, owner, repo, name, color string) int {
	t.Helper()
	label := f.request(t, http.MethodPost, fmt.Sprintf("/repos/%s/%s/labels", owner, repo), map[string]any{
		"name": name, "color": "#" + color,
	})
	id, ok := label["id"].(float64)
	require.True(t, ok, "expected a label id in the response: %+v", label)
	return int(id)
}

// createPullRequestWithStatus creates a real branch, a real commit on it
// (via the contents API, so no local git tooling is needed), a pull
// request from that branch, and a commit status on its head — the whole
// chain internal/forgejo.Client's ListOpenPullRequests + CI resolution
// walks.
func (f *forgejoFixture) createPullRequestWithStatus(t *testing.T, owner, repo, title, ciState string) {
	t.Helper()

	f.request(t, http.MethodPost, fmt.Sprintf("/repos/%s/%s/branches", owner, repo), map[string]any{
		"new_branch_name": "feature", "old_branch_name": "main",
	})

	content := base64.StdEncoding.EncodeToString([]byte("hello widget"))
	file := f.request(t, http.MethodPost, fmt.Sprintf("/repos/%s/%s/contents/widget.txt", owner, repo), map[string]any{
		"branch": "feature", "content": content, "message": "add widget.txt",
	})
	commit, ok := file["commit"].(map[string]any)
	require.True(t, ok, "expected a commit object in the contents response: %+v", file)
	sha, ok := commit["sha"].(string)
	require.True(t, ok && sha != "", "expected a commit sha: %+v", commit)

	f.request(t, http.MethodPost, fmt.Sprintf("/repos/%s/%s/pulls", owner, repo), map[string]any{
		"head": "feature", "base": "main", "title": title,
	})

	f.request(t, http.MethodPost, fmt.Sprintf("/repos/%s/%s/statuses/%s", owner, repo, sha), map[string]any{
		"state": ciState, "description": "test run", "context": "ci",
	})
}

func TestForgejoClient_AgainstARealInstance(t *testing.T) {
	ctx := t.Context()

	baseURL, container := startForgejo(t)
	token := createAdminToken(t, container)
	fixture := &forgejoFixture{baseURL: baseURL, token: token}

	fixture.createRepo(t, "widgets")
	// A real label, against the real API — confirms Client's Label.Color
	// matches Forgejo's actual field name and hex format ("1d76db", no
	// leading "#" even though the create-label call above needs one),
	// not just an assumption the unit tests' hand-built JSON fixtures
	// share with the production code.
	bugLabelID := fixture.createLabel(t, "testadmin", "widgets", "kind/bug", "1d76db")
	fixture.createIssue(t, "testadmin", "widgets", "A real issue", bugLabelID)
	fixture.createPullRequestWithStatus(t, "testadmin", "widgets", "Add widget.txt", "success")

	// A real archived repo, against the real API — confirms Client's
	// filter matches Forgejo's actual "archived" field name and value,
	// not just an assumption the unit tests' hand-built JSON fixtures
	// share with the production code.
	fixture.createRepo(t, "mothballed")
	fixture.archiveRepo(t, "testadmin", "mothballed")

	client := forgejo.NewClient(baseURL, token, "")

	repos, err := client.ListRepos(ctx)
	require.NoError(t, err)
	require.Len(t, repos, 1, "the archived repo should be excluded")
	require.Equal(t, "testadmin/widgets", repos[0].FullName)

	prs, err := client.ListOpenPullRequests(ctx, "testadmin", "widgets", "testadmin/widgets")
	require.NoError(t, err)
	require.Len(t, prs, 1)
	require.Equal(t, "Add widget.txt", prs[0].Title)
	require.Equal(t, dashboard.CISuccess, prs[0].CI)

	issues, err := client.ListOpenIssues(ctx, "testadmin", "widgets", "testadmin/widgets")
	require.NoError(t, err)
	require.Len(t, issues, 1)
	require.Equal(t, "A real issue", issues[0].Title)
	require.Equal(t, []dashboard.Label{{Name: "kind/bug", Color: "1d76db"}}, issues[0].Labels)

	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency)
	result := source.Fetch(ctx)
	require.True(t, result.Health.Reachable)
	require.Len(t, result.PullRequests, 1)
	require.Len(t, result.Issues, 1)

	// The public fallback, unauthenticated, against the same real instance
	// — "widgets" is public by default (createRepo never set private), so
	// it should show up the same way it would to anyone browsing without
	// an account.
	anonClient := forgejo.NewClient(baseURL, "", "testadmin")
	publicRepos, err := anonClient.ListRepos(ctx)
	require.NoError(t, err)
	require.Len(t, publicRepos, 1)
	require.Equal(t, "testadmin/widgets", publicRepos[0].FullName)
}

// TestForgejoClient_PullRequestBehindBase_AgainstARealInstance is what
// justified dashboard.PullRequest.Behind being its own field instead of a
// MergeStatus value in the first place: probed live against this same
// image, a real Forgejo pull request's own `mergeable` flag stayed true
// after a new commit landed on its base branch — Forgejo doesn't
// recompute it synchronously — so Behind has to come from somewhere else
// (Base.Sha, refetched live on every request, diverging from MergeBase,
// fixed at the PR's original common ancestor) and has to keep working
// even while `mergeable` is still reporting true.
func TestForgejoClient_PullRequestBehindBase_AgainstARealInstance(t *testing.T) {
	ctx := t.Context()

	baseURL, container := startForgejo(t)
	token := createAdminToken(t, container)
	fixture := &forgejoFixture{baseURL: baseURL, token: token}

	fixture.createRepo(t, "gadgets")
	fixture.request(t, http.MethodPost, "/repos/testadmin/gadgets/branches", map[string]any{
		"new_branch_name": "feature", "old_branch_name": "main",
	})
	fixture.request(t, http.MethodPost, "/repos/testadmin/gadgets/contents/feature.txt", map[string]any{
		"branch": "feature", "content": base64.StdEncoding.EncodeToString([]byte("feature")), "message": "feature commit",
	})
	fixture.request(t, http.MethodPost, "/repos/testadmin/gadgets/pulls", map[string]any{
		"head": "feature", "base": "main", "title": "Add feature.txt",
	})

	client := forgejo.NewClient(baseURL, token, "")

	before, err := client.ListOpenPullRequests(ctx, "testadmin", "gadgets", "testadmin/gadgets")
	require.NoError(t, err)
	require.Len(t, before, 1)
	require.False(t, before[0].Behind, "a pull request branched directly off its base isn't behind yet")
	require.Equal(t, dashboard.MergeMergeable, before[0].MergeStatus)

	// A new commit on main, untouched by the pull request itself — this is
	// what "behind" means.
	fixture.request(t, http.MethodPost, "/repos/testadmin/gadgets/contents/main-only.txt", map[string]any{
		"branch": "main", "content": base64.StdEncoding.EncodeToString([]byte("main-only")), "message": "main-only commit",
	})

	after, err := client.ListOpenPullRequests(ctx, "testadmin", "gadgets", "testadmin/gadgets")
	require.NoError(t, err)
	require.Len(t, after, 1)
	require.True(t, after[0].Behind, "the base branch moved, so this pull request should now report behind")
	require.Equal(t, dashboard.MergeMergeable, after[0].MergeStatus,
		"mergeable shouldn't have flipped just because the base moved — this is the real staleness this test guards against being relied on")
}

// TestForgejoClient_ReviewState_AgainstARealInstance proves what the stubbed
// unit tests can only assume: that a real Forgejo reports requested
// reviewers on the PR, returns submitted reviews from the reviews endpoint,
// and bumps the PR's updated_at when a review lands, so the client's
// updated_at-keyed cache refetches instead of serving a stale state.
func TestForgejoClient_ReviewState_AgainstARealInstance(t *testing.T) {
	ctx := t.Context()

	baseURL, container := startForgejo(t)
	token := createAdminToken(t, container)
	fixture := &forgejoFixture{baseURL: baseURL, token: token}

	fixture.createRepo(t, "gizmos")
	fixture.createPullRequestWithStatus(t, "testadmin", "gizmos", "Add widget.txt", "success")
	fixture.request(t, http.MethodPost, "/admin/users", map[string]any{
		"username": "reviewer", "email": "reviewer@example.com", "password": "TestPassw0rd1!", "must_change_password": false,
	})
	fixture.request(t, http.MethodPut, "/repos/testadmin/gizmos/collaborators/reviewer", map[string]any{"permission": "write"})

	// One client throughout, so every assertion also exercises its cache.
	client := forgejo.NewClient(baseURL, token, "")
	review := func() (*dashboard.ReviewState, time.Time) {
		t.Helper()
		prs, err := client.ListOpenPullRequests(ctx, "testadmin", "gizmos", "testadmin/gizmos")
		require.NoError(t, err)
		require.Len(t, prs, 1)
		require.NotNil(t, prs[0].Review)

		return prs[0].Review, prs[0].UpdatedAt
	}

	state, _ := review()
	require.Equal(t, dashboard.ReviewNone, state.Decision)

	// Forgejo's updated_at has one-second resolution, so each change waits
	// for the clock to tick over; within the same second the cache would
	// (correctly, by its key) serve the state from before the change.
	time.Sleep(1100 * time.Millisecond)
	fixture.request(t, http.MethodPost, "/repos/testadmin/gizmos/pulls/1/requested_reviewers", map[string]any{"reviewers": []string{"reviewer"}})
	state, updatedAfterRequest := review()
	require.Equal(t, dashboard.ReviewRequired, state.Decision)
	require.Equal(t, 1, state.RequestedReviewers)

	time.Sleep(1100 * time.Millisecond)
	fixture.requestAs(t, "reviewer", http.MethodPost, "/repos/testadmin/gizmos/pulls/1/reviews", map[string]any{"event": "REQUEST_CHANGES", "body": "not yet"})
	state, updatedAfterChanges := review()
	require.True(t, updatedAfterChanges.After(updatedAfterRequest), "a submitted review must bump updated_at, or the cache never refetches")
	require.Equal(t, dashboard.ReviewChangesRequested, state.Decision)

	time.Sleep(1100 * time.Millisecond)
	fixture.requestAs(t, "reviewer", http.MethodPost, "/repos/testadmin/gizmos/pulls/1/reviews", map[string]any{"event": "APPROVED", "body": "now good"})
	state, updatedAfterApproval := review()
	require.True(t, updatedAfterApproval.After(updatedAfterChanges))
	require.Equal(t, dashboard.ReviewApproved, state.Decision)
	require.Equal(t, 1, state.Approvals)
}

// rawRequest is request without the "must succeed" check: it returns the
// status and body as Forgejo sent them, for calls the test expects to be
// refused.
func (f *forgejoFixture) rawRequest(t *testing.T, method, path string, body any) (int, string) {
	t.Helper()
	var reqBody bytes.Buffer
	if body != nil {
		require.NoError(t, json.NewEncoder(&reqBody).Encode(body))
	}
	req, err := http.NewRequestWithContext(t.Context(), method, f.baseURL+"/api/v1"+path, &reqBody)
	require.NoError(t, err)
	req.Header.Set("Authorization", "token "+f.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var out bytes.Buffer
	_, err = out.ReadFrom(resp.Body)
	require.NoError(t, err)

	return resp.StatusCode, out.String()
}

// TestForgejoClient_ActionsOnFinishedPullRequests_AgainstARealInstance proves
// what the stubbed unit tests can only assume: that a pull request already
// merged or closed on the forge is read back as such, and that the dashboard's
// merge and close attempts on it classify as already_merged or already_closed.
func TestForgejoClient_ActionsOnFinishedPullRequests_AgainstARealInstance(t *testing.T) {
	ctx := t.Context()

	baseURL, container := startForgejo(t)
	token := createAdminToken(t, container)
	fixture := &forgejoFixture{baseURL: baseURL, token: token}
	client := forgejo.NewClient(baseURL, token, "")

	// Two pull requests with their own head branches, so each can finish
	// differently without the other's merge making it conflict.
	fixture.createRepo(t, "doodads")
	for _, branch := range []string{"merged-one", "closed-one"} {
		fixture.request(t, http.MethodPost, "/repos/testadmin/doodads/branches", map[string]any{
			"new_branch_name": branch, "old_branch_name": "main",
		})
		fixture.request(t, http.MethodPost, "/repos/testadmin/doodads/contents/"+branch+".txt", map[string]any{
			"branch": branch, "content": base64.StdEncoding.EncodeToString([]byte(branch)), "message": branch,
		})
		fixture.request(t, http.MethodPost, "/repos/testadmin/doodads/pulls", map[string]any{
			"head": branch, "base": "main", "title": branch,
		})
	}
	// The merge answers with an empty body, which request can't decode.
	status, body := fixture.rawRequest(t, http.MethodPost, "/repos/testadmin/doodads/pulls/1/merge", map[string]any{"Do": "merge"})
	require.Less(t, status, 300, body)
	fixture.request(t, http.MethodPatch, "/repos/testadmin/doodads/pulls/2", map[string]any{"state": "closed"})

	merged, err := client.ReadPullRequestState(ctx, "testadmin", "doodads", 1)
	require.NoError(t, err)
	require.True(t, merged.Merged)

	closed, err := client.ReadPullRequestState(ctx, "testadmin", "doodads", 2)
	require.NoError(t, err)
	require.True(t, closed.Closed)
	require.False(t, closed.Merged)

	for name, tc := range map[string]struct {
		number int
		state  dashboard.PullRequestState
		want   dashboard.ActionCode
	}{
		"merged": {1, merged, dashboard.ActionAlreadyMerged},
		"closed": {2, closed, dashboard.ActionAlreadyClosed},
	} {
		t.Run(name, func(t *testing.T) {
			mergeErr := client.MergePullRequest(ctx, "testadmin", "doodads", tc.number)
			require.Error(t, mergeErr)
			t.Logf("merge %s: %v", name, mergeErr)
			require.Equal(t, tc.want, dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionMerge, mergeErr, &tc.state).Code)

			// Forgejo refuses to close a merged pull request ("it was already
			// merged"), but closing an already closed one succeeds: there is
			// no already_closed refusal to classify on Close.
			closeErr := client.ClosePullRequest(ctx, "testadmin", "doodads", tc.number)
			t.Logf("close %s: %v", name, closeErr)
			if tc.want == dashboard.ActionAlreadyClosed {
				require.NoError(t, closeErr)

				return
			}
			require.Error(t, closeErr)
			require.Equal(t, tc.want, dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionClose, closeErr, &tc.state).Code)
		})
	}
}

// TestForgejoClient_ScheduledMerge_AgainstARealInstance proves the timeline
// event names the scheduled-merge reader depends on: a merge scheduled in
// Forgejo shows as auto-merging, and cancelling it stops showing it.
func TestForgejoClient_ScheduledMerge_AgainstARealInstance(t *testing.T) {
	ctx := t.Context()

	baseURL, container := startForgejo(t)
	token := createAdminToken(t, container)
	fixture := &forgejoFixture{baseURL: baseURL, token: token}
	client := forgejo.NewClient(baseURL, token, "")

	fixture.createRepo(t, "sprockets")
	fixture.createPullRequestWithStatus(t, "testadmin", "sprockets", "Add widget.txt", "pending")

	autoMerging := func() *bool {
		t.Helper()
		prs, err := client.ListOpenPullRequests(ctx, "testadmin", "sprockets", "testadmin/sprockets")
		require.NoError(t, err)
		require.Len(t, prs, 1)

		return prs[0].AutoMergeEnabled
	}
	timelineTypes := func() []string {
		t.Helper()
		status, body := fixture.rawRequest(t, http.MethodGet, "/repos/testadmin/sprockets/issues/1/timeline", nil)
		require.Equal(t, http.StatusOK, status)
		var events []struct {
			Type string `json:"type"`
		}
		require.NoError(t, json.Unmarshal([]byte(body), &events))
		types := make([]string, 0, len(events))
		for _, e := range events {
			types = append(types, e.Type)
		}

		return types
	}

	status, body := fixture.rawRequest(t, http.MethodPost, "/repos/testadmin/sprockets/pulls/1/merge",
		map[string]any{"Do": "merge", "merge_when_checks_succeed": true})
	t.Logf("schedule: %d %s", status, body)
	require.Less(t, status, 300)
	t.Logf("timeline after schedule: %v", timelineTypes())
	got := autoMerging()
	require.NotNil(t, got)
	require.True(t, *got, "a merge scheduled in the web UI should show as auto-merging")

	status, body = fixture.rawRequest(t, http.MethodDelete, "/repos/testadmin/sprockets/pulls/1/merge", nil)
	t.Logf("cancel: %d %s", status, body)
	require.Less(t, status, 300)
	t.Logf("timeline after cancel: %v", timelineTypes())
	got = autoMerging()
	require.NotNil(t, got)
	require.False(t, *got, "a cancelled schedule should stop showing as auto-merging")
}
