package github_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type ackComment struct {
	id      int
	body    string
	created time.Time
}

// ackServer serves one pull request's comments and the reactions on each.
func ackServer(t *testing.T, comments []ackComment, reactions map[string][]map[string]any) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/issues/7/comments", func(w http.ResponseWriter, _ *http.Request) {
		list := make([]map[string]any, 0, len(comments))
		for _, c := range comments {
			list = append(list, map[string]any{
				"id": c.id, "body": c.body, "created_at": c.created.UTC().Format(time.RFC3339),
				"html_url": "https://github.com/o/r/pull/7#issuecomment-" + strconv.Itoa(c.id),
			})
		}
		writeJSON(t, w, list)
	})
	for id, list := range reactions {
		mux.HandleFunc("/repos/o/r/issues/comments/"+id+"/reactions", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, list)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func reaction(content, login string) map[string]any {
	return map[string]any{"id": 1, "content": content, "user": map[string]any{"login": login}}
}

func TestClient_DependabotAck(t *testing.T) {
	t.Parallel()

	since := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	const command = "@dependabot rebase"
	later := since.Add(10 * time.Second)

	t.Run("a thumbs-up from Dependabot on the command comment is an acknowledgement", func(t *testing.T) {
		t.Parallel()
		srv := ackServer(t,
			[]ackComment{{42, command, later}},
			map[string][]map[string]any{"42": {reaction("+1", "dependabot[bot]")}})

		got, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.NoError(t, err)
		assert.True(t, got.Acknowledged)
		assert.Equal(t, "https://github.com/o/r/pull/7#issuecomment-42", got.CommentURL)
	})

	t.Run("a comment nobody reacted to yet only gives its link", func(t *testing.T) {
		t.Parallel()
		srv := ackServer(t,
			[]ackComment{{42, command, later}},
			map[string][]map[string]any{"42": {}})

		got, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.NoError(t, err)
		assert.False(t, got.Acknowledged)
		assert.NotEmpty(t, got.CommentURL)
	})

	t.Run("a thumbs-up from someone else, or another reaction from Dependabot, does not count", func(t *testing.T) {
		t.Parallel()
		srv := ackServer(t,
			[]ackComment{{42, command, later}},
			map[string][]map[string]any{"42": {reaction("+1", "alrayyes"), reaction("eyes", "dependabot[bot]")}})

		got, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.NoError(t, err)
		assert.False(t, got.Acknowledged)
	})

	t.Run("an older comment with the same text is not this request", func(t *testing.T) {
		t.Parallel()
		srv := ackServer(t,
			[]ackComment{{41, command, since.Add(-time.Hour)}},
			map[string][]map[string]any{"41": {reaction("+1", "dependabot[bot]")}})

		got, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CommandAck{}, got)
	})

	t.Run("another command's comment is not this request", func(t *testing.T) {
		t.Parallel()
		srv := ackServer(t, []ackComment{{42, "@dependabot recreate", later}}, nil)

		got, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CommandAck{}, got)
	})

	t.Run("with several matching comments the newest one counts", func(t *testing.T) {
		t.Parallel()
		srv := ackServer(t,
			[]ackComment{{42, command, later}, {43, command, later.Add(time.Minute)}},
			map[string][]map[string]any{"42": {reaction("+1", "dependabot[bot]")}, "43": {}})

		got, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.NoError(t, err)
		assert.False(t, got.Acknowledged)
		assert.Equal(t, "https://github.com/o/r/pull/7#issuecomment-43", got.CommentURL)
	})

	t.Run("a forge error comes back as an error", func(t *testing.T) {
		t.Parallel()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(srv.Close)

		_, err := github.NewClient("t", "", srv.URL).DependabotAck(t.Context(), "o", "r", 7, command, since)

		require.Error(t, err)
	})
}
