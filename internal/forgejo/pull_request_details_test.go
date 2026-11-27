package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func reactionJSON(login, content string) map[string]any {
	return map[string]any{"user": map[string]any{"login": login}, "content": content}
}

func TestGetPullRequestDetails_ReadsDescriptionCommentsAndReactions(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "Adds the dialog."})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{reactionJSON("demo-a", "+1"), reactionJSON("demo-b", "+1"), reactionJSON("demo-c", "heart")})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Total-Count", "3")
		writeJSON(t, w, []any{
			map[string]any{
				"id": 11, "body": "Looks good.", "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z",
				"user": map[string]any{"login": "demo-a", "avatar_url": "https://git.example.com/avatars/1"},
			},
			map[string]any{
				"id": 12, "body": "Fixed.", "created_at": "2026-10-01T11:00:00Z", "updated_at": "2026-10-02T09:00:00Z",
				"user": nil,
			},
		})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/reviews", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/comments/11/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{reactionJSON("demo-b", "-1")})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/comments/12/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	got, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.Equal(t, "Adds the dialog.", got.Description.Text)
	assert.Equal(t, dashboard.FormatMarkdown, got.Description.Format)
	assert.False(t, got.Description.Edited, "Forgejo doesn't say whether a description was edited")
	assert.Equal(t, 2, got.Description.Reactions.ThumbsUp.Count)
	assert.Equal(t, []string{"demo-a", "demo-b"}, got.Description.Reactions.ThumbsUp.Logins)
	assert.Equal(t, []string{}, got.Description.Reactions.ThumbsDown.Logins)

	assert.Equal(t, 3, got.CommentCount)
	assert.True(t, got.CommentsTruncated, "three comments exist, two came back")
	require.Len(t, got.Comments, 2)
	first, second := got.Comments[0], got.Comments[1]
	assert.Equal(t, "11", first.ID)
	require.NotNil(t, first.Author)
	assert.Equal(t, "https://git.example.com/avatars/1", first.Author.AvatarURL)
	assert.False(t, first.Edited)
	assert.Equal(t, 1, first.Reactions.ThumbsDown.Count)
	assert.Nil(t, second.Author, "a deleted author is null")
	assert.True(t, second.Edited, "updated after it was created")
	require.NotNil(t, second.UpdatedAt)
}

func TestGetPullRequestDetails_StopsAtTheFirstRateLimit(t *testing.T) {
	t.Parallel()

	const comments = 50
	var commentReactionCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "x"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) {
		list := make([]any, 0, comments)
		for i := range comments {
			list = append(list, map[string]any{
				"id": i + 1, "body": "c", "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z",
			})
		}
		writeJSON(t, w, list)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/comments/", func(w http.ResponseWriter, _ *http.Request) {
		commentReactionCalls.Add(1)
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")

	got, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr, "an error with a code, not a partial thread")
	assert.Equal(t, dashboard.ForgeErrorRateLimited, clientErr.Kind)
	assert.NotNil(t, clientErr.RateLimit)
	assert.Empty(t, got.Comments, "nothing partial comes back with the error")
	assert.Equal(t, dashboard.PullRequestDetails{}, got)
	assert.Less(t, int(commentReactionCalls.Load()), comments/2, "the first refusal stops the rest of the reads")
}

// detailsMux answers everything the dialog reads for a pull request with no
// description reactions and no conversation, and `reviews` for the reviews.
func detailsMux(t *testing.T, reviews http.HandlerFunc) *http.ServeMux {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "x"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5/reviews", reviews)

	return mux
}

// Review comments on lines of code are counted, not listed (#5011): every
// review's comment count added up, across the pages of reviews.
func TestGetPullRequestDetails_CountsTheReviewCommentsOnLinesOfCode(t *testing.T) {
	t.Parallel()

	var srv *httptest.Server
	srv = httptest.NewServer(detailsMux(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			writeJSON(t, w, []any{map[string]any{"id": 3, "state": "COMMENT", "comments_count": 4}})

			return
		}
		w.Header().Set("Link", `<`+srv.URL+`/api/v1/repos/alrayyes/a/pulls/5/reviews?page=2>; rel="next"`)
		writeJSON(t, w, []any{
			map[string]any{"id": 1, "state": "COMMENT", "comments_count": 2},
			map[string]any{"id": 2, "state": "APPROVED", "comments_count": 0},
		})
	}))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, 6, got.ReviewCommentCount)
	assert.False(t, got.ReviewCommentsTruncated, "every page of reviews is read")
	assert.Empty(t, got.Comments, "counted, not listed")
}

// A count that can't be read is an error, never "no line comments".
func TestGetPullRequestDetails_FailsWhenTheReviewsCannotBeRead(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(detailsMux(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorRateLimited, clientErr.Kind)
	assert.Equal(t, dashboard.PullRequestDetails{}, got)
}
