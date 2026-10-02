package github_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testAppPrivateKeyPEM is a throwaway RSA key generated once and reused
// across every App-mode test in this file — key generation isn't free,
// and every case here needs the identical, merely-valid-shaped key.
var testAppPrivateKeyPEM = generateTestAppPrivateKeyPEM()

func generateTestAppPrivateKeyPEM() []byte {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
}

func TestValidateAppPrivateKey_MalformedKey_ReturnsError(t *testing.T) {
	t.Parallel()

	err := github.ValidateAppPrivateKey(1, []byte("not a pem"))

	require.Error(t, err)
}

func TestValidateAppPrivateKey_ValidKey_ReturnsNil(t *testing.T) {
	t.Parallel()

	err := github.ValidateAppPrivateKey(1, testAppPrivateKeyPEM)

	require.NoError(t, err)
}

func TestNewAppClient_MalformedKey_ReturnsError(t *testing.T) {
	t.Parallel()

	_, err := github.NewAppClient(1, 1, []byte("not a pem"), "")

	require.Error(t, err)
}

// testInstallationID is the installation ID every test in this file
// authenticates as — a fixed value rather than a parameter, since no
// case here needs a second one.
const testInstallationID = 1

// appInstallationTestServer serves the installation-token-minting
// endpoint ghinstallation's Transport calls internally, GET
// /installation/repositories (fetchAppRepos' own repo-discovery call —
// #625), and /graphql for the batched per-repo query fetchAppRepos runs
// against whatever that listing returned. This replaces an earlier
// version of this fixture that faked a working `viewer.repositories`
// GraphQL response for App mode — that's not how real GitHub behaves
// for an installation token (a GitHub App installation access token has
// no associated user, so `viewer` has no repositories connection to
// hang affiliations off of), and no test built against that fake mock
// ever caught #625 because of it. mintCount lets a test assert the mint
// endpoint was actually hit, so a passing Fetch can't be accidentally
// explained by silently falling through to the unauthenticated REST
// path instead of GraphQL.
//
// The fixture is two repos, r0 with one open pull request and r1 with
// one open issue, aliased in that order because fetchAppRepos batches
// candidates in the order GET /installation/repositories returned them.
func appInstallationTestServer(t *testing.T) (srv *httptest.Server, mintCount *int, lastAuthHeader *string) {
	t.Helper()
	mintCount = new(int)
	lastAuthHeader = new(string)

	mux := http.NewServeMux()
	mintPath := fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID)
	mux.HandleFunc(mintPath, func(w http.ResponseWriter, _ *http.Request) {
		*mintCount++
		writeJSON(t, w, map[string]any{
			"token":      "installation-token-value",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, r *http.Request) {
		*lastAuthHeader = r.Header.Get("Authorization")
		writeJSON(t, w, map[string]any{
			"total_count": 2,
			"repositories": []map[string]any{
				{"name": "repo-one", "full_name": "alrayyes/repo-one", "html_url": "https://github.com/alrayyes/repo-one", "fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"}},
				{"name": "repo-two", "full_name": "alrayyes/repo-two", "html_url": "https://github.com/alrayyes/repo-two", "fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"}},
			},
		})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		*lastAuthHeader = r.Header.Get("Authorization")
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "cost": 2, "remaining": 4998, "resetAt": "2026-09-14T16:00:00Z"},
				"r0": map[string]any{
					"pullRequests": map[string]any{
						"nodes": []map[string]any{
							{
								"number": 7, "title": "Fix the thing", "url": "https://github.com/alrayyes/repo-one/pull/7",
								"isDraft": false, "author": map[string]any{"login": "alrayyes"},
								"mergeStateStatus": "CLEAN", "headRefOid": "deadbeef",
								"additions": 3, "deletions": 1, "changedFiles": 2,
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-09-20T10:00:00Z", "updatedAt": "2026-09-20T10:00:00Z",
								"commits": map[string]any{"nodes": []map[string]any{{"commit": map[string]any{"statusCheckRollup": map[string]any{"state": "SUCCESS"}}}}},
							},
						},
					},
					"issuesTotal": map[string]any{"totalCount": 0},
					"issues":      map[string]any{"nodes": []map[string]any{}},
				},
				"r1": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{}},
					"issuesTotal":  map[string]any{"totalCount": 1},
					"issues": map[string]any{
						"nodes": []map[string]any{
							{
								"number": 3, "title": "Something's broken", "url": "https://github.com/alrayyes/repo-two/issues/3",
								"author":    map[string]any{"login": "alrayyes"},
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-09-21T10:00:00Z", "updatedAt": "2026-09-21T10:00:00Z",
							},
						},
					},
				},
			},
		})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, mintCount, lastAuthHeader
}

func TestAppClient_Fetch_UsesGraphQLPath(t *testing.T) {
	t.Parallel()

	srv, _, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
}

// TestAppClient_Fetch_ReturnsInstallationRepositoriesPRsAndIssues is the
// test #625 shipped without: every other case in this file only ever
// asserted Health.Reachable, which stayed true even when the old
// viewer-based query silently returned zero repos for an installation
// token. This asserts the actual repo/PR/issue counts fetchAppRepos'
// REST + batched-GraphQL discovery is supposed to produce.
func TestAppClient_Fetch_ReturnsInstallationRepositoriesPRsAndIssues(t *testing.T) {
	t.Parallel()

	srv, _, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 2, result.Health.RepoCount)
	require.Len(t, result.PullRequests, 1)
	assert.Equal(t, "alrayyes/repo-one", result.PullRequests[0].Repo)
	assert.Equal(t, 7, result.PullRequests[0].Number)
	require.Len(t, result.Issues, 1)
	assert.Equal(t, "alrayyes/repo-two", result.Issues[0].Repo)
	assert.Equal(t, 3, result.Issues[0].Number)
}

func TestAppClient_Fetch_MintsAnInstallationToken(t *testing.T) {
	t.Parallel()

	srv, mintCount, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	client.Fetch(t.Context())

	assert.Equal(t, 1, *mintCount, "Fetch should have minted a real installation token, not fallen through to an unauthenticated path")
}

func TestAppClient_Fetch_DoesNotSendTheBrokenEmptyBearerHeader(t *testing.T) {
	t.Parallel()

	srv, _, lastAuthHeader := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	client.Fetch(t.Context())

	assert.NotEqual(t, "Bearer ", *lastAuthHeader, "graphqlDo's own header-set must be guarded so an App-mode Client never sends this broken value")
}

func TestAppClient_Fetch_SendsTheRealMintedToken(t *testing.T) {
	t.Parallel()

	srv, _, lastAuthHeader := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	client.Fetch(t.Context())

	assert.Contains(t, *lastAuthHeader, "installation-token-value")
}

func TestNewUnreachableClient_Fetch_ReportsTheGivenReason(t *testing.T) {
	t.Parallel()

	client := github.NewUnreachableClient("github: app installation credentials are invalid")
	result := client.Fetch(t.Context())

	require.False(t, result.Health.Reachable)
	assert.Equal(t, "github: app installation credentials are invalid", result.Health.Error)
}

// dependabotBlocker is the optional capability dashboard.Source
// implementations expose when Dependabot would refuse their comments (#666).
type dependabotBlocker interface {
	DependabotCommandsBlockedReason() string
}

func TestAppClient_DependabotCommandsBlockedReason_WithoutPersonalToken_ExplainsWhy(t *testing.T) {
	t.Parallel()

	srv, _, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	assert.Contains(t, client.DependabotCommandsBlockedReason(), "personal access token")
}

func TestAppClient_DependabotCommandsBlockedReason_WithPersonalToken_IsEmpty(t *testing.T) {
	t.Parallel()

	srv, _, _ := appInstallationTestServer(t)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetCommentToken("pat-value")

	assert.Empty(t, client.DependabotCommandsBlockedReason())
}

func TestPATClient_DependabotCommandsBlockedReason_IsEmpty(t *testing.T) {
	t.Parallel()

	var blocker dependabotBlocker = github.NewClient("pat-value", "", "")

	assert.Empty(t, blocker.DependabotCommandsBlockedReason())
}

func TestAppClient_CommentPullRequest_WithPersonalToken_PostsAsThePersonalToken(t *testing.T) {
	t.Parallel()

	var commentAuth string
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"token":      "installation-token-value",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/repos/alrayyes/repo-one/issues/7/comments", func(w http.ResponseWriter, r *http.Request) {
		commentAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
		writeJSON(t, w, map[string]any{"id": 1})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetCommentToken("pat-value")

	err = client.CommentPullRequest(t.Context(), "alrayyes", "repo-one", 7, "@dependabot rebase")

	require.NoError(t, err)
	assert.Equal(t, "Bearer pat-value", commentAuth, "Dependabot only honours a user, so the comment must carry the personal token, not the App's")
}
