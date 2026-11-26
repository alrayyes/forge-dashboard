package oauth_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// reposHost serves GET /user/installations/42/repositories: 150 repos over two
// pages of 100, the first one with a mixed-case name.
func reposHost(t *testing.T) *fakeGitHub {
	t.Helper()

	gh := newFakeGitHub(t)
	gh.mux.HandleFunc("/user/installations/42/repositories", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghu-1" {
			http.Error(w, "no", http.StatusUnauthorized)

			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		lo, hi := 0, 100
		if page == 2 {
			lo, hi = 100, 150
		}
		var repos []map[string]string
		for i := lo; i < hi; i++ {
			name := fmt.Sprintf("octo/r%d", i)
			if i == 0 {
				name = "Octo/R0"
			}
			repos = append(repos, map[string]string{"full_name": name})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 150, "repositories": repos})
	})

	return gh
}

func TestGitHub_InstallationRepos_ListsEveryPageLowerCased(t *testing.T) {
	t.Parallel()

	gh := reposHost(t)
	store := &ghTokens{instance: gh.server.URL, token: &oauth2.Token{AccessToken: "ghu-1", RefreshToken: "ghr-1", Expiry: time.Now().Add(time.Hour)}}
	conn := oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghRedirect, store, gh.urls())

	got, err := conn.InstallationRepos(t.Context(), 42)

	require.NoError(t, err)
	assert.Len(t, got, 150)
	assert.Contains(t, got, "octo/r0")
	assert.Contains(t, got, "octo/r149")
}

func TestGitHub_InstallationRepos_NotConnectedIsAnError(t *testing.T) {
	t.Parallel()

	gh := reposHost(t)
	conn := oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghRedirect, &ghTokens{}, gh.urls())

	_, err := conn.InstallationRepos(t.Context(), 42)

	assert.ErrorIs(t, err, oauth.ErrNotConnected)
}
