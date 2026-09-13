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
		Image:        "codeberg.org/forgejo/forgejo:10.0.3@sha256:99b6c15a1bc98e623103a83a04023662a93fd035dac4f0a856d781afa9d71095",
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
	require.Less(t, resp.StatusCode, 300, "request to %s failed", path)

	var out map[string]any
	if resp.StatusCode != http.StatusNoContent {
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	}
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
