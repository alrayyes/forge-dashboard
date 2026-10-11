package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	githubpkg "github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeGitHub answers the two GraphQL queries the dashboard sends (the
// account-wide one and the single-repo one) for one repo holding pull
// request #78, and can be made to behave the way the real API does right
// after a merge (#966): keep listing the pull request as open for a few
// more reads, or fail outright.
type fakeGitHub struct {
	mu sync.Mutex
	// merged is set once #78 has merged on the fake.
	merged bool
	// staleReads is how many pull request lists, after the merge, still
	// show #78 as open: GitHub's read-after-write lag.
	staleReads int
	// failRepoReads makes the single-repo query answer 502.
	failRepoReads bool
}

func (f *fakeGitHub) merge(staleReads int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.merged, f.staleReads = true, staleReads
}

func (f *fakeGitHub) reopen() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.merged = false
}

func (f *fakeGitHub) failRepoQuery() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failRepoReads = true
}

// listsOpen reports whether the pull request list being answered right now
// still contains #78.
func (f *fakeGitHub) listsOpen() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.merged {
		return true
	}
	if f.staleReads > 0 {
		f.staleReads--

		return true
	}

	return false
}

func (f *fakeGitHub) pullRequests() []map[string]any {
	if !f.listsOpen() {
		return []map[string]any{}
	}

	return []map[string]any{{
		"number": 78, "title": "Merge me", "url": "https://github.com/alrayyes/a/pull/78",
		"isDraft": false, "author": map[string]any{"login": "alrayyes"},
		"mergeStateStatus": "CLEAN",
		"labels":           map[string]any{"nodes": []map[string]any{}},
		"createdAt":        "2026-10-05T11:00:00Z", "updatedAt": "2026-10-05T11:29:00Z",
		"commits": map[string]any{"nodes": []map[string]any{
			{"commit": map[string]any{"statusCheckRollup": map[string]any{"state": "SUCCESS"}}},
		}},
	}}
}

func (f *fakeGitHub) serve(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query string `json:"query"`
		}
		assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		w.Header().Set("Content-Type", "application/json")

		if !strings.Contains(body.Query, "repository(owner: $owner, name: $name)") {
			assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4990, "resetAt": "2099-01-01T00:00:00Z"},
				"viewer": map[string]any{"repositories": map[string]any{
					"pageInfo": map[string]any{"hasNextPage": false},
					"nodes": []map[string]any{{
						"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "ADMIN",
						"owner":        map[string]any{"login": "alrayyes"},
						"pullRequests": map[string]any{"nodes": f.pullRequests()},
						"issues":       map[string]any{"nodes": []map[string]any{}},
					}},
				}},
			}}))

			return
		}

		f.mu.Lock()
		fail := f.failRepoReads
		f.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusBadGateway)

			return
		}
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"repository": map[string]any{
				"pullRequests": map[string]any{"nodes": f.pullRequests()},
				"issues":       map[string]any{"nodes": []map[string]any{}},
			},
		}}))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// pullRequestDelivery is the body GitHub sends for a pull_request event on #78.
func pullRequestDelivery(action string, merged bool) []byte {
	return fmt.Appendf(nil, `{"action":%q,"number":78,"pull_request":{"number":78,"state":"closed","merged":%t},"repository":{"full_name":"alrayyes/a","name":"a","owner":{"login":"alrayyes"}}}`, action, merged)
}

func postGitHubDelivery(t *testing.T, srvURL, token, secret string, body []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "delivery-966")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}

// boardServer starts the dashboard with a real github.Client pointed at fake,
// waits for the first refresh to list #78, and returns what a webhook
// delivery needs.
func boardServer(t *testing.T, fake *fakeGitHub) (srvURL string, cookie *http.Cookie, token, secret string) {
	t.Helper()
	gh := fake.serve(t)
	srvURL, cookie = newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, githubpkg.NewClient("test-token", "", gh.URL))
	require.Eventually(t, func() bool {
		return len(prNumbers(t, fetchDashboardWith(t, srvURL, cookie, ""))) == 1
	}, 5*time.Second, 10*time.Millisecond, "the first refresh should list #78")
	token, secret = webhookCredentials(t, srvURL, cookie)

	return srvURL, cookie, token, secret
}

func boardLists78(t *testing.T, srvURL string, cookie *http.Cookie) bool {
	t.Helper()

	return len(prNumbers(t, fetchDashboardWith(t, srvURL, cookie, ""))) > 0
}

// Replays the incident on forgejo-caldav-sync#78 (#966): the pull request
// merged, GitHub delivered `pull_request closed`, and the read that followed
// still listed it as open. The delivery says it is closed, so the board must
// not keep offering Merge.
func TestGitHubWebhook_ClosedDelivery_APullRequestGitHubStillListsOpenLeavesTheBoard(t *testing.T) {
	t.Parallel()

	fake := &fakeGitHub{}
	srvURL, cookie, token, secret := boardServer(t, fake)

	fake.merge(1)
	postGitHubDelivery(t, srvURL, token, secret, pullRequestDelivery("closed", true))

	assert.Eventually(t, func() bool { return !boardLists78(t, srvURL, cookie) }, 10*time.Second, 20*time.Millisecond,
		"within 10 seconds of the closed delivery the dashboard must stop listing #78")
}

// A scoped refresh that fails leaves the snapshot as it was. The delivery
// itself is still proof the pull request closed.
func TestGitHubWebhook_ClosedDelivery_AFailedScopedRefreshStillRemovesThePullRequestAndLogsIt(t *testing.T) {
	var logs syncBuffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	fake := &fakeGitHub{}
	srvURL, cookie, token, secret := boardServer(t, fake)

	fake.merge(0)
	fake.failRepoQuery()
	postGitHubDelivery(t, srvURL, token, secret, pullRequestDelivery("closed", true))

	require.Eventually(t, func() bool { return !boardLists78(t, srvURL, cookie) }, 10*time.Second, 20*time.Millisecond,
		"a failed fetch must not keep a closed pull request on the board")
	require.Eventually(t, func() bool { return strings.Contains(logs.String(), "scoped refresh failed") }, 5*time.Second, 20*time.Millisecond)
	logged := logs.String()
	assert.Contains(t, logged, "repo=alrayyes/a")
	assert.Contains(t, logged, "pull_request=78")
	assert.Contains(t, logged, "delivery=delivery-966")
}

// Settling a pull request on a closed delivery must not outlive a reopen.
func TestGitHubWebhook_ReopenedDelivery_BringsThePullRequestBack(t *testing.T) {
	t.Parallel()

	fake := &fakeGitHub{}
	srvURL, cookie, token, secret := boardServer(t, fake)

	fake.merge(1)
	postGitHubDelivery(t, srvURL, token, secret, pullRequestDelivery("closed", false))
	require.Eventually(t, func() bool { return !boardLists78(t, srvURL, cookie) }, 10*time.Second, 20*time.Millisecond)

	fake.reopen()
	postGitHubDelivery(t, srvURL, token, secret, pullRequestDelivery("reopened", false))

	assert.Eventually(t, func() bool { return boardLists78(t, srvURL, cookie) }, 10*time.Second, 20*time.Millisecond,
		"a reopened pull request is open again")
}

// syncBuffer is a bytes.Buffer that the server's goroutines can log into
// while the test reads it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	n, _ := b.buf.Write(p) // a bytes.Buffer never fails to write

	return n, nil
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.String()
}
