package github_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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

// A GitHub App account sees the box too (#1349): its batched per-repo query is
// a third selection of the same pull request fields.
func TestAppClient_Fetch_ReadsWhetherRenovatesRebaseBoxIsTicked(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"token":      "installation-token-value",
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"total_count": 1,
			"repositories": []map[string]any{
				{"name": "repo-one", "full_name": "alrayyes/repo-one", "html_url": "https://github.com/alrayyes/repo-one", "fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"}},
			},
		})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "pullRequests(") {
			query = q
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"r0": map[string]any{
					"pullRequests": map[string]any{
						"nodes": []map[string]any{
							{
								"number": 7, "title": "Update dependency foo", "url": "https://github.com/alrayyes/repo-one/pull/7",
								"isDraft": false, "author": map[string]any{"login": "renovate"},
								"mergeStateStatus": "CLEAN", "headRefOid": "deadbeef",
								"body":      "- [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box",
								"labels":    map[string]any{"nodes": []map[string]any{}},
								"createdAt": "2026-09-20T10:00:00Z", "updatedAt": "2026-09-20T10:00:00Z",
								"commits": map[string]any{"nodes": []map[string]any{}},
							},
						},
					},
					"issuesTotal": map[string]any{"totalCount": 0},
					"issues":      map[string]any{"nodes": []map[string]any{}},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	assert.True(t, result.PullRequests[0].RenovateRebaseRequested)
	assert.Regexp(t, `(?m)^\s+body\s*$`, query, "the App query has to ask for the description")
}

// appWebhookTestServer is appInstallationTestServer's two repos with a hooks
// endpoint per repo, answering with the status given (200 means an empty
// list). An installation token has no viewer, so the hooks call is the only
// honest answer to "can this connection manage webhooks here".
func appWebhookTestServer(t *testing.T, hookStatus map[string]int, messages ...string) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"total_count": 2,
			"repositories": []map[string]any{
				{"name": "repo-one", "full_name": "alrayyes/repo-one", "html_url": "https://github.com/alrayyes/repo-one", "owner": map[string]any{"login": "alrayyes"}},
				{"name": "repo-two", "full_name": "alrayyes/repo-two", "html_url": "https://github.com/alrayyes/repo-two", "owner": map[string]any{"login": "alrayyes"}},
			},
		})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		empty := map[string]any{
			"pullRequests": map[string]any{"nodes": []map[string]any{}},
			"issuesTotal":  map[string]any{"totalCount": 0},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 2, "remaining": 4998, "resetAt": "2026-09-14T16:00:00Z"},
			"r0":        empty,
			"r1":        empty,
		}})
	})
	for name, status := range hookStatus {
		mux.HandleFunc("/repos/alrayyes/"+name+"/hooks", func(w http.ResponseWriter, _ *http.Request) {
			if status == http.StatusOK {
				writeJSON(t, w, []map[string]any{})

				return
			}
			message := "Resource not accessible by integration"
			if len(messages) > 0 {
				message = messages[0]
			}
			if strings.Contains(message, "rate limit") {
				w.Header().Set("X-RateLimit-Limit", "5000")
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
			}
			w.WriteHeader(status)
			writeJSON(t, w, map[string]any{"message": message})
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestAppClient_Fetch_CanManageWebhooksFollowsTheHooksCall(t *testing.T) {
	t.Parallel()

	srv := appWebhookTestServer(t, map[string]int{"repo-one": http.StatusOK, "repo-two": http.StatusNotFound})
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	result := client.Fetch(t.Context())

	byName := map[string]bool{}
	limited := map[string]bool{}
	for _, r := range result.Repos {
		byName[r.FullName] = r.CanManageWebhooks
		limited[r.FullName] = r.WebhookLockedByConnection
	}
	assert.Equal(t, map[string]bool{"alrayyes/repo-one": true, "alrayyes/repo-two": false}, byName,
		"an installation has no viewer role; a hooks listing that works means the Add button can too")
	assert.Equal(t, map[string]bool{"alrayyes/repo-one": false, "alrayyes/repo-two": true}, limited,
		"a repo the App can't reach hooks on is the connection's limit, not the user's role")
}

func TestAppClient_Fetch_AppWithoutWebhooksPermission_LocksEveryRepoAsConnectionLimit(t *testing.T) {
	t.Parallel()

	srv := appWebhookTestServer(t, map[string]int{"repo-one": http.StatusForbidden, "repo-two": http.StatusForbidden})
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	result := client.Fetch(t.Context())

	require.Len(t, result.Repos, 2)
	for _, r := range result.Repos {
		assert.False(t, r.CanManageWebhooks, r.FullName)
		assert.True(t, r.WebhookLockedByConnection, r.FullName)
	}
}

// TestAppClient_Fetch_AppWithoutWebhooksPermission_LocksReposProbedAfterTheDenial
// pins that the verdict doesn't depend on which repo's hooks call lands first.
// Only DefaultMaxConcurrency hooks calls run at once, so with more repos than
// that, some are always checked after the first refusal has been recorded. The
// denial is app-wide, so those repos have to read as locked too (#1871).
func TestAppClient_Fetch_AppWithoutWebhooksPermission_LocksReposProbedAfterTheDenial(t *testing.T) {
	t.Parallel()

	const repoCount = dashboard.DefaultMaxConcurrency + 2
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	repos := make([]map[string]any, 0, repoCount)
	data := map[string]any{"rateLimit": map[string]any{"limit": 5000, "cost": 2, "remaining": 4998, "resetAt": "2026-09-14T16:00:00Z"}}
	for i := range repoCount {
		name := fmt.Sprintf("repo-%02d", i)
		repos = append(repos, map[string]any{"name": name, "full_name": "alrayyes/" + name, "html_url": "https://github.com/alrayyes/" + name, "owner": map[string]any{"login": "alrayyes"}})
		data[fmt.Sprintf("r%d", i)] = map[string]any{
			"pullRequests": map[string]any{"nodes": []map[string]any{}},
			"issuesTotal":  map[string]any{"totalCount": 0},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}
		mux.HandleFunc("/repos/alrayyes/"+name+"/hooks", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			writeJSON(t, w, map[string]any{"message": "Resource not accessible by integration"})
		})
	}
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": repoCount, "repositories": repos})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": data})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	result := client.Fetch(t.Context())

	require.Len(t, result.Repos, repoCount)
	for _, r := range result.Repos {
		assert.False(t, r.CanManageWebhooks, r.FullName)
		assert.True(t, r.WebhookLockedByConnection, r.FullName)
	}
}

// TestAppClient_Fetch_UnknownHooksAnswer_DoesNotLockOrBlameTheConnection pins
// that only a real refusal (403 "not accessible by integration", or 404)
// reads as the connection's limit. Anything else says nothing about the App's
// permission, so the row stays unlocked and unflagged.
func TestAppClient_Fetch_UnknownHooksAnswer_DoesNotLockOrBlameTheConnection(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		status  int
		message string
		noPath  bool
	}{
		"server error":               {status: http.StatusInternalServerError, message: "boom"},
		"primary rate limit":         {status: http.StatusForbidden, message: "API rate limit exceeded for installation"},
		"bad credentials":            {status: http.StatusUnauthorized, message: "Bad credentials"},
		"no webhook path configured": {status: http.StatusOK, noPath: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv := appWebhookTestServer(t, map[string]int{"repo-one": tc.status, "repo-two": tc.status}, tc.message)
			client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
			require.NoError(t, err)
			if !tc.noPath {
				client.SetWebhookPath("/api/webhooks/github/tok123")
			}

			result := client.Fetch(t.Context())

			require.Len(t, result.Repos, 2)
			for _, r := range result.Repos {
				assert.True(t, r.CanManageWebhooks, r.FullName)
				assert.False(t, r.WebhookLockedByConnection, r.FullName)
			}
		})
	}
}

func TestAppClient_EnsureWebhook_ReadOnlyApp_NamesTheAppPermission(t *testing.T) {
	t.Parallel()

	// Webhooks: read lets the listing through, so the Add button shows; the
	// create is what GitHub refuses.
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/repos/alrayyes/repo-one/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusForbidden)
			writeJSON(t, w, map[string]any{"message": "Resource not accessible by integration"})

			return
		}
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	err = client.EnsureWebhook(t.Context(), "alrayyes", "repo-one", "https://dash.example/api/webhooks/github/t", "s")

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "%v", err)
	assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind)
	assert.Contains(t, clientErr.PermissionMessage, "Webhooks (Read and write)")
	assert.Contains(t, clientErr.PermissionMessage, "accept")
	assert.NotContains(t, clientErr.PermissionMessage, "token")
}

func TestAppClient_Fetch_FailedHooksCallKeepsThePreviousRefusal(t *testing.T) {
	t.Parallel()

	var status atomic.Int32
	status.Store(http.StatusNotFound)
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "repositories": []map[string]any{
			{"name": "repo-one", "full_name": "alrayyes/repo-one", "html_url": "https://github.com/alrayyes/repo-one", "owner": map[string]any{"login": "alrayyes"}},
		}})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
			"r0": map[string]any{
				"pullRequests": map[string]any{"nodes": []map[string]any{}},
				"issuesTotal":  map[string]any{"totalCount": 0},
				"issues":       map[string]any{"nodes": []map[string]any{}},
			},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/repo-one/hooks", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(status.Load()))
		writeJSON(t, w, map[string]any{"message": "Not Found"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	first := client.Fetch(t.Context())
	status.Store(http.StatusInternalServerError)
	second := client.Fetch(t.Context())

	require.Len(t, first.Repos, 1)
	require.Len(t, second.Repos, 1)
	assert.True(t, first.Repos[0].WebhookLockedByConnection)
	assert.True(t, second.Repos[0].WebhookLockedByConnection, "a 500 says nothing new about the permission")
}
