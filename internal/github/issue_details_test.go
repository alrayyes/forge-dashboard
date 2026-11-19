package github_test

import (
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"regexp"
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
		// What the fake knows is one number: an issue unless the test says it is
		// a pull request, as GitHub's issueOrPullRequest union answers it.
		item := map[string]any{"__typename": "Issue"}
		maps.Copy(item, issue)
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"issueOrPullRequest": item}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// A number that is a pull request opens as one. repository.issue(number:)
// answers "Could not resolve to an Issue" for it (#4188), so the lookup asks
// the union and says which kind it got, and the page picks the dialog.
func TestGetIssueDetails_ANumberThatIsAPullRequestSaysSo(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := issueDetailsServer(t, map[string]any{
		"__typename": "PullRequest", "state": "MERGED", "body": "Adds the thing.", "lastEditedAt": nil,
		"title":          "Add structured logging",
		"author":         map[string]any{"login": "claude", "avatarUrl": "https://avatars.example.com/u/9"},
		"reactionGroups": []map[string]any{},
		"comments":       map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 4177)

	require.NoError(t, err)
	require.Len(t, queries, 1, "one request")
	assert.Contains(t, queries[0].Query, "issueOrPullRequest(number: $number)")
	assert.Equal(t, dashboard.ItemKindPullRequest, got.Kind)
	assert.Equal(t, "Adds the thing.", got.Description.Text)
	assert.Equal(t, dashboard.IssueStateClosed, got.State, "merged is not open")
	require.NotNil(t, got.PullRequest, "the facts the header needs ride along")
	assert.Equal(t, "Add structured logging", got.PullRequest.Title)
	assert.Equal(t, dashboard.ReferencedStateMerged, got.PullRequest.State, "merged is told apart from closed")
	require.NotNil(t, got.PullRequest.Author)
	assert.Equal(t, "claude", got.PullRequest.Author.Login)
	assert.Equal(t, "https://avatars.example.com/u/9", got.PullRequest.Author.AvatarURL)
}

func TestGetIssueDetails_AClosedPullRequestIsNotMerged(t *testing.T) {
	t.Parallel()

	srv := issueDetailsServer(t, map[string]any{
		"__typename": "PullRequest", "state": "CLOSED", "title": "Drop it", "author": nil, "body": "x", "lastEditedAt": nil,
		"reactionGroups": []map[string]any{},
		"comments":       map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, nil)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 4177)

	require.NoError(t, err)
	require.NotNil(t, got.PullRequest)
	assert.Equal(t, dashboard.ReferencedStateClosed, got.PullRequest.State)
	assert.Nil(t, got.PullRequest.Author, "a deleted account has no author")
}

func TestGetIssueDetails_AnIssueSaysItIsAnIssue(t *testing.T) {
	t.Parallel()

	srv := issueDetailsServer(t, map[string]any{
		"state": "OPEN", "body": "x", "lastEditedAt": nil, "reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, nil)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, dashboard.ItemKindIssue, got.Kind)
	assert.Equal(t, dashboard.IssueStateOpen, got.State)
	assert.Nil(t, got.PullRequest, "an issue carries no pull request facts")
}

// One GraphQL query reads the description, the comments and every reaction
// group, the same cost as a pull request's dialog: a single request.
func TestGetIssueDetails_ReadsTheThreadInOneQuery(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := issueDetailsServer(t, map[string]any{
		"body":         "The page loses its place.",
		"state":        "CLOSED",
		"lastEditedAt": "2026-10-02T09:00:00Z",
		"reactionGroups": []map[string]any{
			reactionGroup("THUMBS_UP", 2, "demo-a", "demo-b"),
			reactionGroup("HEART", 4, "demo-c"),
		},
		"comments": map[string]any{
			"totalCount": 2,
			"nodes": []map[string]any{
				{
					"id": "IC_1", "databaseId": 101, "createdAt": "2026-10-01T10:00:00Z", "lastEditedAt": nil, "body": "Seen it too.",
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
	assert.Contains(t, queries[0].Query, "issueOrPullRequest(number: $number)")
	assert.EqualValues(t, 5, queries[0].Variables["number"])
	assert.Equal(t, "The page loses its place.", got.Description.Text)
	assert.Equal(t, dashboard.FormatMarkdown, got.Description.Format)
	assert.True(t, got.Description.Edited)
	assert.Equal(t, dashboard.IssueStateClosed, got.State)
	assert.Equal(t, 2, got.Description.Reactions.ThumbsUp.Count)
	assert.Equal(t, []string{"demo-a", "demo-b"}, got.Description.Reactions.ThumbsUp.Logins)
	require.Len(t, got.Comments, 2)
	assert.Equal(t, "101", got.Comments[0].ID, "the number the comments route takes, not the GraphQL node id")
	assert.Equal(t, "demo-a", got.Comments[0].Author.Login)
	assert.Equal(t, "https://avatars.example.com/u/1", got.Comments[0].Author.AvatarURL, "the forge's own avatar, unchanged")
	assert.Nil(t, got.Comments[1].Author, "a deleted account has no author")
	assert.True(t, got.Comments[1].Edited)
	assert.Equal(t, 2, got.CommentCount)
	assert.False(t, got.CommentsTruncated)
}

// The comments route takes the REST number, which GraphQL calls databaseId. A
// query that asked for the node id instead would leave every comment id at 0,
// and the mocked response can't tell, so the request text is checked.
func TestGetIssueDetails_AsksForTheDatabaseIDOnComments(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := issueDetailsServer(t, map[string]any{
		"body": "x", "lastEditedAt": nil, "reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
	}, &queries)

	_, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, queries, 1)
	block := regexp.MustCompile(`(?s)comments\(first: 50\) \{.*?nodes \{(.*?)author`).FindStringSubmatch(queries[0].Query)
	require.Len(t, block, 2, "the comment nodes selection")
	assert.Regexp(t, `\bdatabaseId\b`, block[1])
	assert.NotRegexp(t, `\bid\b`, block[1], "the node id is not the comment number")
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
			"data":   map[string]any{"repository": map[string]any{"issueOrPullRequest": nil}},
			"errors": []map[string]any{{"type": "NOT_FOUND", "message": "Could not resolve to an issue or pull request with the number of 5."}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
	assert.Equal(t, "github: issue or pull request not found: #5 in alrayyes/a", err.Error(), "plain words, not GitHub's GraphQL text")
	assert.NotContains(t, err.Error(), "graphql")
}

// An issue that comes back null with no error beside it is still not there, so
// the dialog gets a not-found and not an empty thread.
func TestGetIssueDetails_ANullIssueWithNoErrorIsANotFound(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"issueOrPullRequest": nil}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

func crossReference(source map[string]any, willClose bool) map[string]any {
	return map[string]any{"willCloseTarget": willClose, "source": source}
}

func referencingItem(typename, repo string, number int, title, state string) map[string]any {
	return map[string]any{
		"__typename": typename, "number": number, "title": title, "state": state,
		"url":        fmt.Sprintf("https://github.com/%s/issues/%d", repo, number),
		"repository": map[string]any{"nameWithOwner": repo},
	}
}

// What refers to an issue is the forge's own record, so a closed issue has it
// whether or not the board lists it (#4271).
func TestGetIssueDetails_ReadsWhatReferToTheIssue(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := issueDetailsServer(t, map[string]any{
		"state": "CLOSED", "body": "x", "lastEditedAt": nil, "reactionGroups": []map[string]any{},
		"comments": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
		"timelineItems": map[string]any{"nodes": []map[string]any{
			crossReference(referencingItem("Issue", "alrayyes/b", 3, "Follow-up", "CLOSED"), false),
			crossReference(referencingItem("PullRequest", "alrayyes/a", 12, "Fix it", "MERGED"), true),
			crossReference(referencingItem("PullRequest", "alrayyes/a", 12, "Fix it", "MERGED"), false),
			{},
		}},
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	require.Len(t, queries, 1, "the references ride in the one request")
	assert.Contains(t, queries[0].Query, "CROSS_REFERENCED_EVENT")
	require.Len(t, got.References, 2, "one entry per item, and a node that isn't a cross reference is skipped")
	// Newest first: the forge lists oldest first.
	assert.Equal(t, 12, got.References[0].Number)
	assert.Equal(t, "alrayyes/a", got.References[0].Repo)
	assert.Equal(t, dashboard.ItemKindPullRequest, got.References[0].Kind)
	assert.Equal(t, dashboard.ReferencedStateMerged, got.References[0].State)
	assert.Equal(t, dashboard.RelationCloses, got.References[0].Relation, "a closing event wins over a mention of the same item")
	assert.Equal(t, dashboard.ReferenceIncoming, got.References[0].Direction)
	assert.Equal(t, dashboard.ForgeGitHub, got.References[0].Forge)
	assert.Equal(t, "Fix it", got.References[0].Title)
	assert.Equal(t, dashboard.ItemKindIssue, got.References[1].Kind)
	assert.Equal(t, dashboard.ReferencedStateClosed, got.References[1].State)
	assert.Equal(t, dashboard.RelationMentions, got.References[1].Relation)
}

// outgoingServer answers the details read with the given issue and the lookup
// of what its text names (an aliased query, t0, t1 and so on) from items, keyed
// by "owner/name#number". An item not in it comes back null, as GitHub answers
// a number that is not there.
func outgoingServer(t *testing.T, issue map[string]any, items map[string]map[string]any, queries *[]graphqlRequestBody) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		*queries = append(*queries, body)
		if _, lookup := body.Variables["owner0"]; !lookup {
			item := map[string]any{"__typename": "Issue"}
			maps.Copy(item, issue)
			writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"issueOrPullRequest": item}}})

			return
		}
		data := map[string]any{}
		for i := 0; ; i++ {
			owner, ok := body.Variables[fmt.Sprintf("owner%d", i)]
			if !ok {
				break
			}
			key := fmt.Sprintf("%s/%s#%v", owner, body.Variables[fmt.Sprintf("name%d", i)], body.Variables[fmt.Sprintf("number%d", i)])
			answer := map[string]any{"issueOrPullRequest": nil}
			if item, found := items[key]; found {
				answer["issueOrPullRequest"] = item
			}
			data[fmt.Sprintf("t%d", i)] = answer
		}
		writeJSON(t, w, map[string]any{"data": data})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func quietIssue(body string) map[string]any {
	return map[string]any{
		"state": "OPEN", "title": "Show outgoing", "body": body, "lastEditedAt": nil, "reactionGroups": []map[string]any{},
		"comments":      map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
		"timelineItems": map[string]any{"nodes": []map[string]any{}},
	}
}

// What the issue itself refers to is read from its text and looked up in one
// more request (#4272), so a merged pull request the board doesn't track is
// still listed with its state.
func TestGetIssueDetails_ReadsWhatTheIssueRefersTo(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := outgoingServer(t, quietIssue("Refs #4271, alrayyes/b#4297. Also #9 and #404."), map[string]map[string]any{
		"alrayyes/a#4271": referencingItem("Issue", "alrayyes/a", 4271, "A closed issue shows no references", "CLOSED"),
		"alrayyes/b#4297": referencingItem("PullRequest", "alrayyes/b", 4297, "Show the Related band", "MERGED"),
		"alrayyes/a#9":    referencingItem("Issue", "alrayyes/a", 9, "Nine", "OPEN"),
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 4305)

	require.NoError(t, err)
	require.Len(t, queries, 2, "the details, then one lookup for every target")
	require.Len(t, got.References, 3, "#404 is not there and is left out")
	first, second, third := got.References[0], got.References[1], got.References[2]
	assert.Equal(t, 4271, first.Number)
	assert.Equal(t, dashboard.ReferenceOutgoing, first.Direction)
	assert.Equal(t, dashboard.RelationRefs, first.Relation)
	assert.Equal(t, dashboard.ReferencedStateClosed, first.State)
	assert.Equal(t, dashboard.ItemKindIssue, first.Kind)
	assert.Equal(t, "A closed issue shows no references", first.Title)
	assert.Equal(t, dashboard.ForgeGitHub, first.Forge)
	assert.Equal(t, "alrayyes/b", second.Repo)
	assert.Equal(t, dashboard.ItemKindPullRequest, second.Kind)
	assert.Equal(t, dashboard.ReferencedStateMerged, second.State)
	assert.Equal(t, "https://github.com/alrayyes/b/issues/4297", second.URL)
	assert.Equal(t, dashboard.RelationMentions, third.Relation)
	assert.Equal(t, 9, third.Number)
}

// Incoming ones stay in front, then what the item refers to.
func TestGetIssueDetails_IncomingComeBeforeOutgoing(t *testing.T) {
	t.Parallel()

	issue := quietIssue("See #9")
	issue["timelineItems"] = map[string]any{"nodes": []map[string]any{
		crossReference(referencingItem("PullRequest", "alrayyes/a", 12, "Fix it", "MERGED"), true),
	}}
	var queries []graphqlRequestBody
	srv := outgoingServer(t, issue, map[string]map[string]any{
		"alrayyes/a#9": referencingItem("Issue", "alrayyes/a", 9, "Nine", "OPEN"),
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	require.Len(t, got.References, 2)
	assert.Equal(t, dashboard.ReferenceIncoming, got.References[0].Direction)
	assert.Equal(t, dashboard.ReferenceOutgoing, got.References[1].Direction)
}

func TestGetIssueDetails_NamingNothingAsksNothing(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := outgoingServer(t, quietIssue("Nothing to see."), nil, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	assert.Len(t, queries, 1, "no lookup request")
	assert.Empty(t, got.References)
}

// A lookup that fails outright must not take the dialog's thread with it: the
// description and comments are what the reader opened it for.
func TestGetIssueDetails_AFailedLookupLeavesTheThread(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if _, lookup := body.Variables["owner0"]; lookup {
			http.Error(w, "boom", http.StatusForbidden)

			return
		}
		item := map[string]any{"__typename": "Issue"}
		maps.Copy(item, quietIssue("See #9"))
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"issueOrPullRequest": item}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	assert.Equal(t, "See #9", got.Description.Text)
	assert.Empty(t, got.References)
}

// A pull request closes what it says it closes.
func TestGetIssueDetails_APullRequestListsWhatItCloses(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	pr := quietIssue("Closes #3")
	pr["__typename"] = "PullRequest"
	pr["author"] = nil
	srv := outgoingServer(t, pr, map[string]map[string]any{
		"alrayyes/a#3": referencingItem("Issue", "alrayyes/a", 3, "Three", "CLOSED"),
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, dashboard.RelationCloses, got.References[0].Relation)
}

// The title is read as well as the description.
func TestGetIssueDetails_TheTitleCountsForWhatItRefersTo(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	issue := quietIssue("")
	issue["title"] = "Follow up #9"
	srv := outgoingServer(t, issue, map[string]map[string]any{
		"alrayyes/a#9": referencingItem("Issue", "alrayyes/a", 9, "Nine", "OPEN"),
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 9, got.References[0].Number)
}

// A link to an item counts when it is a page on the forge: github.com, or the
// host the item itself is on.
func TestGetIssueDetails_ALinkToAnItemOnTheForgeIsNamed(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct{ itemURL, host string }{
		"github.com": {"", "https://github.com"},
		"enterprise": {"https://ghe.example.com/alrayyes/a/issues/7", "https://ghe.example.com"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			var queries []graphqlRequestBody
			issue := quietIssue("See " + tc.host + "/alrayyes/b/pull/4297 for the fix.")
			issue["url"] = tc.itemURL
			srv := outgoingServer(t, issue, map[string]map[string]any{
				"alrayyes/b#4297": referencingItem("PullRequest", "alrayyes/b", 4297, "Fix", "MERGED"),
			}, &queries)

			got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

			require.NoError(t, err)
			require.Len(t, got.References, 1)
			assert.Equal(t, 4297, got.References[0].Number)
		})
	}
}

// The repository is spelled as GitHub spells it, not as the text did.
func TestGetIssueDetails_TheTargetsRepoIsTheForgesSpelling(t *testing.T) {
	t.Parallel()

	var queries []graphqlRequestBody
	srv := outgoingServer(t, quietIssue("See alrayyes/b#5"), map[string]map[string]any{
		"alrayyes/b#5": referencingItem("Issue", "AlRayyes/B", 5, "Five", "OPEN"),
	}, &queries)

	got, err := github.NewClient("test-token", "", srv.URL).GetIssueDetails(t.Context(), "alrayyes", "a", 7)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, "AlRayyes/B", got.References[0].Repo)
}
