package github_test

import (
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	customLogoURL  = "https://repository-images.githubusercontent.com/123/abc"
	defaultCardURL = "https://opengraph.githubassets.com/0123456789abcdef/alrayyes/a"
)

// logoFields is what GitHub's GraphQL sends for a repository's social preview:
// the URL is always there (a generated card when none was uploaded) and the
// flag says whether it is the maintainer's own image.
func logoFields(custom bool, url string) map[string]any {
	return map[string]any{"usesCustomOpenGraphImage": custom, "openGraphImageUrl": url}
}

// tokenRepoNode is the repository node alrayyes/a of the token path's viewer
// query, with the given social preview fields on it.
func tokenRepoNode(logo map[string]any) map[string]any {
	node := map[string]any{
		"name": "a", "url": "https://github.com/alrayyes/a",
		"isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": "alrayyes"},
		"pullRequests": map[string]any{"nodes": []map[string]any{}},
		"issuesTotal":  map[string]any{"totalCount": 0},
		"issues":       map[string]any{"nodes": []map[string]any{}},
	}
	maps.Copy(node, logo)

	return node
}

// fetchTokenRepos runs the token path against one page of repository nodes
// and hands back the first query the client posted with what it returned.
func fetchTokenRepos(t *testing.T, nodes ...map[string]any) (dashboard.Result, string) {
	t.Helper()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if query == "" {
			query = readGraphQLRequest(t, r).Query
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
						"nodes":    nodes,
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL).Fetch(t.Context()), query
}

func TestFetch_RepoWithACustomSocialImage_CarriesItAsTheLogo(t *testing.T) {
	t.Parallel()

	result, _ := fetchTokenRepos(t, tokenRepoNode(logoFields(true, customLogoURL)))

	require.Len(t, result.Repos, 1)
	assert.Equal(t, customLogoURL, result.Repos[0].LogoURL)
}

func TestFetch_RepoWithOnlyTheGeneratedCard_HasNoLogo(t *testing.T) {
	t.Parallel()

	result, _ := fetchTokenRepos(t, tokenRepoNode(logoFields(false, defaultCardURL)))

	require.Len(t, result.Repos, 1)
	assert.Empty(t, result.Repos[0].LogoURL)
}

func TestFetch_LogoThatIsNotAnHTTPSImageOnGitHubsOwnHost_IsDropped(t *testing.T) {
	t.Parallel()

	for _, url := range []string{
		"http://repository-images.githubusercontent.com/123/abc",
		"https://avatars.githubusercontent.com/u/1",
		"https://user-images.githubusercontent.com/1/logo.png",
		"https://raw.githubusercontent.com/alrayyes/a/main/logo.png",
		"https://example.com/logo.png",
		"https://githubusercontent.com.evil.example/logo.png",
		"https://opengraph.githubassets.com/0123456789abcdef/alrayyes/a",
		"javascript:alert(1)",
		"",
	} {
		t.Run(url, func(t *testing.T) {
			t.Parallel()

			result, _ := fetchTokenRepos(t, tokenRepoNode(logoFields(true, url)))

			require.Len(t, result.Repos, 1)
			assert.Empty(t, result.Repos[0].LogoURL)
		})
	}
}

func TestFetch_AsksForTheSocialPreviewOfEachRepo(t *testing.T) {
	t.Parallel()

	_, query := fetchTokenRepos(t, tokenRepoNode(nil))

	assert.Contains(t, query, "usesCustomOpenGraphImage")
	assert.Contains(t, query, "openGraphImageUrl")
}

func TestAppClient_Fetch_RepoWithACustomSocialImage_CarriesItAsTheLogo(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID), func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token-value", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/installation/repositories", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"total_count": 2,
			"repositories": []map[string]any{
				{"name": "a", "full_name": "alrayyes/a", "html_url": "https://github.com/alrayyes/a", "fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"}},
				{"name": "b", "full_name": "alrayyes/b", "html_url": "https://github.com/alrayyes/b", "fork": false, "archived": false, "owner": map[string]any{"login": "alrayyes"}},
			},
		})
	})
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if query == "" {
			query = readGraphQLRequest(t, r).Query
		}
		repo := func(logo map[string]any) map[string]any {
			node := map[string]any{
				"pullRequests": map[string]any{"nodes": []map[string]any{}},
				"issuesTotal":  map[string]any{"totalCount": 0},
				"issues":       map[string]any{"nodes": []map[string]any{}},
			}
			maps.Copy(node, logo)

			return node
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "cost": 1, "remaining": 4999, "resetAt": "2026-09-14T16:00:00Z"},
				"r0":        repo(logoFields(true, customLogoURL)),
				"r1":        repo(logoFields(false, defaultCardURL)),
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client, err := github.NewAppClient(1, testInstallationID, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)

	result := client.Fetch(t.Context())

	require.Len(t, result.Repos, 2)
	assert.Equal(t, customLogoURL, result.Repos[0].LogoURL)
	assert.Empty(t, result.Repos[1].LogoURL)
	assert.Contains(t, query, "usesCustomOpenGraphImage")
	assert.Contains(t, query, "openGraphImageUrl")
}
