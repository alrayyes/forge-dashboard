package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func issueDetailsServer(t *testing.T, issue map[string]any, queries *[]graphqlRequestBody) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if queries != nil {
			*queries = append(*queries, body)
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"issue": issue}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// One GraphQL query reads the description, the comments and every reaction
// group, the same cost as a pull request's dialog: a single request.
func TestGetIssueDetails_ReadsTheThreadInOneQuery(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := issueDetailsServer(t, map[string]any{
		"body":         "The page loses its place.",
		"lastEditedAt": "2026-10-02T09:00:00Z",
		"reactionGroups": []map[string]any{
			reactionGroup("THUMBS_UP", 2, "demo-a", "demo-b"),
			reactionGroup("HEART", 4, "demo-c"),
		},
		"comments": map[string]any{
			"totalCount": 2,
			"nodes": []map[string]any{
				{
					"id": "IC_1", "createdAt": "2026-10-01T10:00:00Z", "lastEditedAt": nil, "body": "Seen it too.",
					"author":         map[string]any{"login": "demo-a", "avatarUrl": "https://avatars.example.com/u/1"},
					"reactionGroups": []map[string]any{reactionGroup("THUMBS_UP", 1, "demo-b")},
				},
				{
					"id": "IC_2", "createdAt": "2026-10-01T11:00:00Z", "lastEditedAt": "2026-10-01T11:30:00Z", "body": "A deleted user's note.",
					"author":         nil,
					"reactionGroups": []map[string]any{},
				},
			},
		},
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, queries, 1, "one request")
	assert.Contains(t, queries[0].Query, "issue(number: $number)")
	assert.EqualValues(t, 5, queries[0].Variables["number"])
	assert.Equal(t, "The page loses its place.", got.Description.Text)
	assert.Equal(t, dashboard.FormatMarkdown, got.Description.Format)
	assert.True(t, got.Description.Edited)
	assert.Equal(t, 2, got.Description.Reactions.ThumbsUp.Count)
	assert.Equal(t, []string{"demo-a", "demo-b"}, got.Description.Reactions.ThumbsUp.Logins)
	require.Len(t, got.Comments, 2)
	assert.Equal(t, "demo-a", got.Comments[0].Author.Login)
	assert.Equal(t, "https://avatars.example.com/u/1", got.Comments[0].Author.AvatarURL, "the forge's own avatar, unchanged")
	assert.Nil(t, got.Comments[1].Author, "a deleted account has no author")
	assert.True(t, got.Comments[1].Edited)
	assert.Equal(t, 2, got.CommentCount)
	assert.False(t, got.CommentsTruncated)
}

func TestGetIssueDetails_AnIssueWithNoCommentsHasAnEmptyList(t *testing.T) {
	t.Parallel()

	srv := issueDetailsServer(t, map[string]any{
		"body": "", "lastEditedAt": nil, "reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, nil)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, []dashboard.DetailsComment{}, got.Comments, "never null")
	assert.Empty(t, got.Description.Text)
}

func TestGetIssueDetails_ACommentThreadLongerThanTheCapIsTruncated(t *testing.T) {
	t.Parallel()

	srv := issueDetailsServer(t, map[string]any{
		"body": "x", "lastEditedAt": nil, "reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 70, "nodes": []map[string]any{
			{"id": "IC_1", "createdAt": "2026-10-01T10:00:00Z", "body": "one", "author": nil, "reactionGroups": []map[string]any{}},
		}},
	}, nil)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.True(t, got.CommentsTruncated)
	assert.Equal(t, 70, got.CommentCount)
}

func TestGetIssueDetails_AMissingIssueIsANotFound(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data":   map[string]any{"repository": map[string]any{"issue": nil}},
			"errors": []map[string]any{{"type": "NOT_FOUND", "message": "Could not resolve to an Issue with the number of 5."}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
	assert.Contains(t, err.Error(), "Issue")
}

// An issue that comes back null with no error beside it is still not there, so
// the dialog gets a not-found and not an empty thread.
func TestGetIssueDetails_ANullIssueWithNoErrorIsANotFound(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"issue": nil}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}
