package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// repoWithAvatar serves one repository the token can push to, whose own
// avatar_url is whatever the test passes ("" is what Forgejo sends for a
// repository that never set one) and whose owner has an avatar of its own.
func repoWithAvatar(t *testing.T, avatarURL string) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{
				"full_name": "alrayyes/a", "name": "a", "avatar_url": avatarURL,
				"owner":       map[string]any{"login": "alrayyes", "avatar_url": "https://git.example/avatar/owner"},
				"permissions": map[string]bool{"push": true},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestListRepos_CarriesTheRepoAvatarAsItsLogo(t *testing.T) {
	t.Parallel()

	srv := repoWithAvatar(t, "https://git.example/repo-avatars/abc")

	repos, err := forgejo.NewClient(srv.URL, "test-token", "").ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Equal(t, "https://git.example/repo-avatars/abc", repos[0].LogoURL)
}

func TestListRepos_NoRepoAvatar_HasNoLogo_NotTheOwnersAvatar(t *testing.T) {
	t.Parallel()

	srv := repoWithAvatar(t, "")

	repos, err := forgejo.NewClient(srv.URL, "test-token", "").ListRepos(t.Context())

	require.NoError(t, err)
	require.Len(t, repos, 1)
	assert.Empty(t, repos[0].LogoURL)
}

func TestListRepos_RepoAvatarThatIsNotHTTPS_HasNoLogo(t *testing.T) {
	t.Parallel()

	for _, avatar := range []string{"http://git.example/repo-avatars/abc", "javascript:alert(1)", "//git.example/x", "/repo-avatars/abc"} {
		t.Run(avatar, func(t *testing.T) {
			t.Parallel()

			srv := repoWithAvatar(t, avatar)

			repos, err := forgejo.NewClient(srv.URL, "test-token", "").ListRepos(t.Context())

			require.NoError(t, err)
			require.Len(t, repos, 1)
			assert.Empty(t, repos[0].LogoURL)
		})
	}
}
