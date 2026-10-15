package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func reactionGroup(content string, total int, logins ...string) map[string]any {
	nodes := []map[string]any{}
	for _, l := range logins {
		nodes = append(nodes, map[string]any{"login": l})
	}

	return map[string]any{"content": content, "users": map[string]any{"totalCount": total, "nodes": nodes}}
}

func detailsServer(t *testing.T, pr map[string]any, queries *[]graphqlRequestBody) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if queries != nil {
			*queries = append(*queries, body)
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// One GraphQL query reads the description, the comments and every reaction
// group (#1506): the cost on GitHub is a single request.
func TestGetPullRequestDetails_ReadsTheThreadInOneQuery(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := detailsServer(t, map[string]any{
		"body":         "Adds the dialog.",
		"lastEditedAt": "2026-10-02T09:00:00Z",
		"author":       map[string]any{"login": "demo-author", "avatarUrl": "https://avatars.example.com/u/9"},
		"reactionGroups": []map[string]any{
			reactionGroup("THUMBS_UP", 2, "demo-a", "demo-b"),
			reactionGroup("THUMBS_DOWN", 0),
			reactionGroup("HEART", 4, "demo-c"),
		},
		"comments": map[string]any{
			"totalCount": 2,
			"nodes": []map[string]any{
				{
					"id": "IC_1", "createdAt": "2026-10-01T10:00:00Z", "lastEditedAt": nil, "body": "Looks good.",
					"author":         map[string]any{"login": "demo-a", "avatarUrl": "https://avatars.example.com/u/1"},
					"reactionGroups": []map[string]any{reactionGroup("THUMBS_UP", 1, "demo-b")},
				},
				{
					"id": "IC_2", "createdAt": "2026-10-01T11:00:00Z", "lastEditedAt": "2026-10-01T11:30:00Z", "body": "Deleted user's note.",
					"author":         nil,
					"reactionGroups": []map[string]any{reactionGroup("THUMBS_DOWN", 3, "demo-a", "demo-b", "demo-c")},
				},
			},
		},
	}, &queries)
	client := github.NewClient("test-token", "", srv.URL)

	got, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, queries, 1, "one request")
	assert.EqualValues(t, "alrayyes", queries[0].Variables["owner"])
	assert.EqualValues(t, "a", queries[0].Variables["name"])
	assert.EqualValues(t, 5, queries[0].Variables["number"])

	assert.Equal(t, "Adds the dialog.", got.Description.Text)
	assert.Equal(t, dashboard.FormatMarkdown, got.Description.Format)
	assert.True(t, got.Description.Edited, "lastEditedAt is set")
	assert.False(t, got.Description.Truncated)
	assert.Equal(t, dashboard.Reaction{Count: 2, Logins: []string{"demo-a", "demo-b"}}, got.Description.Reactions.ThumbsUp)
	assert.Equal(t, dashboard.Reaction{Count: 0, Logins: []string{}}, got.Description.Reactions.ThumbsDown, "a count of zero still names an empty array")

	assert.Equal(t, 2, got.CommentCount)
	assert.False(t, got.CommentsTruncated)
	require.Len(t, got.Comments, 2)
	first, second := got.Comments[0], got.Comments[1]
	assert.Equal(t, "IC_1", first.ID)
	require.NotNil(t, first.Author)
	assert.Equal(t, dashboard.Person{Login: "demo-a", AvatarURL: "https://avatars.example.com/u/1"}, *first.Author)
	assert.Equal(t, "2026-10-01T10:00:00Z", first.CreatedAt)
	assert.Nil(t, first.UpdatedAt)
	assert.False(t, first.Edited)
	assert.Equal(t, dashboard.Reaction{Count: 1, Logins: []string{"demo-b"}}, first.Reactions.ThumbsUp)
	assert.Nil(t, second.Author, "a deleted account has no author")
	require.NotNil(t, second.UpdatedAt)
	assert.Equal(t, "2026-10-01T11:30:00Z", *second.UpdatedAt)
	assert.True(t, second.Edited)
	assert.Equal(t, 3, second.Reactions.ThumbsDown.Count)
}

// The query asks for the first 50 comments and the first 10 reacting logins
// per content, so the response can't outgrow the contract's caps.
func TestGetPullRequestDetails_AsksOnlyForTheCappedAmount(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := detailsServer(t, map[string]any{
		"body": "x", "reactionGroups": []map[string]any{}, "comments": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, &queries)
	client := github.NewClient("test-token", "", srv.URL)

	_, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, queries, 1)
	assert.Contains(t, queries[0].Query, "comments(first: 50)", "the first 50 comments")
	assert.Contains(t, queries[0].Query, "users(first: 10)", "the first 10 reacting logins")
}

func TestGetPullRequestDetails_MoreCommentsThanTheCapAreFlagged(t *testing.T) {
	t.Parallel()

	nodes := []map[string]any{}
	for range 50 {
		nodes = append(nodes, map[string]any{
			"id": "IC", "createdAt": "2026-10-01T10:00:00Z", "body": "c", "author": nil, "reactionGroups": []map[string]any{},
		})
	}
	srv := detailsServer(t, map[string]any{
		"body": "x", "reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 73, "nodes": nodes},
	}, nil)
	client := github.NewClient("test-token", "", srv.URL)

	got, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, 73, got.CommentCount)
	assert.Len(t, got.Comments, 50)
	assert.True(t, got.CommentsTruncated, "the dialog links to the forge for the rest")
}

func TestGetPullRequestDetails_CutsALongBodyAndSaysSo(t *testing.T) {
	t.Parallel()

	srv := detailsServer(t, map[string]any{
		"body":           strings.Repeat("a", dashboard.MaxDetailsBodyRunes+5),
		"reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 1, "nodes": []map[string]any{{
			"id": "IC", "createdAt": "2026-10-01T10:00:00Z", "body": strings.Repeat("b", dashboard.MaxDetailsBodyRunes+1),
			"author": nil, "reactionGroups": []map[string]any{},
		}}},
	}, nil)
	client := github.NewClient("test-token", "", srv.URL)

	got, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.True(t, got.Description.Truncated)
	assert.Len(t, got.Description.Text, dashboard.MaxDetailsBodyRunes)
	require.Len(t, got.Comments, 1)
	assert.True(t, got.Comments[0].Truncated)
}

func TestGetPullRequestDetails_NamesAtMostTenLoginsButCountsAll(t *testing.T) {
	t.Parallel()

	// GitHub is asked for ten; a defensive cap holds if a server sends more.
	logins := []string{}
	for i := range 12 {
		logins = append(logins, string(rune('a'+i)))
	}
	srv := detailsServer(t, map[string]any{
		"body":           "x",
		"reactionGroups": []map[string]any{reactionGroup("THUMBS_UP", 40, logins...)},
		"comments":       map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, nil)
	client := github.NewClient("test-token", "", srv.URL)

	got, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, 40, got.Description.Reactions.ThumbsUp.Count, "the full number")
	assert.Len(t, got.Description.Reactions.ThumbsUp.Logins, dashboard.MaxReactionLogins)
}

// A GraphQL failure is an error the handler classifies, never an empty thread.
func TestGetPullRequestDetails_GraphQLError_IsReturned(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"errors": []map[string]any{{"type": "NOT_FOUND", "message": "Could not resolve to a PullRequest with the number of 5."}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := github.NewClient("test-token", "", srv.URL)

	_, err := client.GetPullRequestDetails(t.Context(), "alrayyes", "a", 5)

	require.Error(t, err)
}
