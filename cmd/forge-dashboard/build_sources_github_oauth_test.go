package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

const ghLinkedRedirect = "https://dash.example.com/api/v1/connections/github/callback"

// linkedGitHub is a fake GitHub: the token endpoint (a refresh works once),
// GET /user, an installation's two repos and what the linked user can read of
// them, and an empty answer for every GraphQL read. It records each GraphQL
// request's Authorization header and what the pair store held at that moment.
type linkedGitHub struct {
	srv   *httptest.Server
	store *pairStore

	mu        sync.Mutex
	graphqlAs []string
	savedThen []string
	login     string
	listCalls int
	listFails bool
}

func (f *linkedGitHub) setLogin(login string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.login = login
}

func (f *linkedGitHub) failList(fails bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listFails = fails
}

func (f *linkedGitHub) listCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.listCalls
}

func newLinkedGitHub(t *testing.T) *linkedGitHub {
	t.Helper()

	f := &linkedGitHub{login: "octocat"}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("grant_type") == "authorization_code" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ghu-3", "refresh_token": "ghr-3", "token_type": "bearer", "expires_in": 28800})

			return
		}
		if r.PostForm.Get("refresh_token") != "ghr-1" {
			http.Error(w, `{"error":"bad_refresh_token"}`, http.StatusBadRequest)

			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ghu-2", "refresh_token": "ghr-2", "token_type": "bearer", "expires_in": 28800})
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		login := f.login
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"login": login})
	})
	mux.HandleFunc("/app/installations/42/access_tokens", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "installation-token", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 2, "repositories": []map[string]any{
			{"name": "one", "full_name": "octocat/one", "html_url": "https://github.com/octocat/one", "owner": map[string]any{"login": "octocat"}},
			{"name": "two", "full_name": "octocat/two", "html_url": "https://github.com/octocat/two", "owner": map[string]any{"login": "octocat"}},
		}})
	})
	mux.HandleFunc("/user/installations/42/repositories", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.listCalls++
		fails, login := f.listFails, f.login
		f.mu.Unlock()
		if fails {
			http.Error(w, "boom", http.StatusInternalServerError)

			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 1, "repositories": []map[string]any{{"full_name": login + "/one"}}})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.graphqlAs = append(f.graphqlAs, r.Header.Get("Authorization"))
		if f.store.token != nil {
			f.savedThen = append(f.savedThen, f.store.token.RefreshToken)
		}
		f.mu.Unlock()

		empty := map[string]any{
			"pullRequests": map[string]any{"nodes": []map[string]any{}},
			"issuesTotal":  map[string]any{"totalCount": 0},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
			"r0":        empty,
			"r1":        empty,
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false}, "nodes": []map[string]any{},
			}},
		}})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)

	return f
}

// link returns the connection for a pair that was granted by this fake, held
// in a store the fake can inspect. Not parallel: it points the package's
// GitHub API address at the fake.
func (f *linkedGitHub) link(t *testing.T, expiry time.Time) *oauth.GitHub {
	t.Helper()

	f.store = &pairStore{instance: f.srv.URL, token: &oauth2.Token{AccessToken: "ghu-1", RefreshToken: "ghr-1", Expiry: expiry}}
	githubAPIBaseURL = f.srv.URL
	t.Cleanup(func() { githubAPIBaseURL = "" })

	return oauth.NewGitHubAt(t.Context(), "id", "secret", ghLinkedRedirect, f.store, oauth.GitHubURLs{Web: f.srv.URL, API: f.srv.URL})
}

func TestBuildSources_ALinkedGitHubAccountWithNoInstallationReadsWithTheRefreshedPairAlreadySaved(t *testing.T) {
	f := newLinkedGitHub(t)
	conn := f.link(t, time.Now().Add(-time.Minute))

	sources := buildSources(newTestAuthStore(t), nil, 0, nil, nil, nil, conn)(settings.Credentials{})
	require.Len(t, sources, 1)
	result := sources[0].Fetch(t.Context())

	require.True(t, result.Health.Reachable, result.Health.Error)
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.graphqlAs)
	for i, auth := range f.graphqlAs {
		assert.Equal(t, "Bearer ghu-2", auth)
		assert.Equal(t, "ghr-2", f.savedThen[i], "the rotated pair was saved before the request that used it")
	}
}

func TestBuildSources_ALinkedGitHubAccountWinsOverASavedPersonalToken(t *testing.T) {
	f := newLinkedGitHub(t)
	conn := f.link(t, time.Now().Add(time.Hour))

	sources := buildSources(newTestAuthStore(t), nil, 0, nil, nil, nil, conn)(settings.Credentials{GitHubToken: "pasted"})
	require.Len(t, sources, 1)
	sources[0].Fetch(t.Context())

	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.graphqlAs)
	assert.Equal(t, "Bearer ghu-1", f.graphqlAs[0])
}

func TestBuildSources_AnInstallationReadsOnlyTheReposTheLinkedAccountCanRead(t *testing.T) {
	f := newLinkedGitHub(t)
	conn := f.link(t, time.Now().Add(time.Hour))

	sources := buildSources(newTestAuthStore(t), nil, 1, testGitHubAppPrivateKeyPEM, nil, nil, conn)(settings.Credentials{GitHubAppInstallationID: 42, GitHubAppInstallationIDs: []int64{42}})
	require.Len(t, sources, 1)
	result := sources[0].Fetch(t.Context())

	require.True(t, result.Health.Reachable, result.Health.Error)
	assert.Equal(t, 1, result.Health.RepoCount, fmt.Sprint(result.Health))
}

func TestBuildSources_AnInstallationWithNoLinkedAccountReadsEveryRepoItSees(t *testing.T) {
	f := newLinkedGitHub(t)
	conn := f.link(t, time.Now().Add(time.Hour))
	require.NoError(t, conn.Disconnect(t.Context()))

	sources := buildSources(newTestAuthStore(t), nil, 1, testGitHubAppPrivateKeyPEM, nil, nil, conn)(settings.Credentials{GitHubAppInstallationID: 42, GitHubAppInstallationIDs: []int64{42}})
	require.Len(t, sources, 1)
	result := sources[0].Fetch(t.Context())

	require.True(t, result.Health.Reachable, result.Health.Error)
	assert.Equal(t, 2, result.Health.RepoCount)
}

func TestVisibleRepos_ARelinkAsAnotherUserIsNotFilteredByTheOldUsersList(t *testing.T) {
	f := newLinkedGitHub(t)
	conn := f.link(t, time.Now().Add(time.Hour))
	read := newVisibleRepos(conn).forInstallation(42)

	first, err := read(t.Context())
	require.NoError(t, err)
	require.Contains(t, first, "octocat/one")

	require.NoError(t, conn.Disconnect(t.Context()))
	f.setLogin("bob")
	state, err := url.Parse(conn.Begin())
	require.NoError(t, err)
	_, err = conn.Finish(t.Context(), state.Query().Get("state"), "code")
	require.NoError(t, err)

	second, err := read(t.Context())
	require.NoError(t, err)
	assert.Contains(t, second, "bob/one")
}

func TestVisibleRepos_AFailureIsRememberedBrieflySoABrokenEndpointIsNotHitOnEveryPoll(t *testing.T) {
	f := newLinkedGitHub(t)
	conn := f.link(t, time.Now().Add(time.Hour))
	f.failList(true)
	read := newVisibleRepos(conn).forInstallation(42)

	_, firstErr := read(t.Context())
	_, secondErr := read(t.Context())

	require.Error(t, firstErr)
	require.Error(t, secondErr)
	assert.Equal(t, 1, f.listCount())
}
