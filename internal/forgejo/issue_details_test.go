package forgejo_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// noReferences answers the timeline of alrayyes/a#5, which the issue reads
// for what refers to it, with nothing on it.
func noReferences(t *testing.T, mux *http.ServeMux) {
	t.Helper()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/timeline", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
}

// An issue reads like a pull request's thread: Forgejo serves both through
// the same issue endpoints, so only the first call differs.
func TestGetIssueDetails_ReadsDescriptionCommentsAndReactions(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	noReferences(t, mux)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "The page loses its place.", "state": "open"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{reactionJSON("demo-a", "+1"), reactionJSON("demo-b", "+1"), reactionJSON("demo-c", "heart")})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Total-Count", "2")
		writeJSON(t, w, []any{
			map[string]any{
				"id": 11, "body": "Seen it too.", "created_at": "2026-10-01T10:00:00Z", "updated_at": "2026-10-01T10:00:00Z",
				"user": map[string]any{"login": "demo-a", "avatar_url": "https://git.example.com/avatars/1"},
			},
			map[string]any{
				"id": 12, "body": "Fixed.", "created_at": "2026-10-01T11:00:00Z", "updated_at": "2026-10-02T09:00:00Z",
				"user": nil,
			},
		})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/comments/11/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{reactionJSON("demo-b", "-1")})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/comments/12/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "The page loses its place.", got.Description.Text)
	assert.Equal(t, dashboard.FormatMarkdown, got.Description.Format)
	assert.Equal(t, 2, got.Description.Reactions.ThumbsUp.Count)
	require.Len(t, got.Comments, 2)
	assert.Equal(t, "demo-a", got.Comments[0].Author.Login)
	assert.Equal(t, "https://git.example.com/avatars/1", got.Comments[0].Author.AvatarURL, "the forge's own avatar, unchanged")
	assert.Equal(t, 1, got.Comments[0].Reactions.ThumbsDown.Count)
	assert.Nil(t, got.Comments[1].Author)
	assert.True(t, got.Comments[1].Edited)
	assert.Equal(t, 2, got.CommentCount)
	assert.Equal(t, dashboard.IssueStateOpen, got.State)
}

func TestGetIssueDetails_ReportsAClosedIssueAsClosed(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	noReferences(t, mux)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "Done.", "state": "closed"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, dashboard.IssueStateClosed, got.State)
}

func TestGetIssueDetails_AMissingIssueIsANotFound(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	noReferences(t, mux)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(t, w, map[string]any{"message": "issue does not exist"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	_, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	var clientErr *dashboard.ClientError
	require.ErrorAs(t, err, &clientErr)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

// Forgejo shares one number space, and GET /issues/{n} answers for a pull
// request too, with a pull_request member. The page needs to be told which it
// got (#4188), since only it knows which dialog to open.
func TestGetIssueDetails_SaysWhetherTheNumberIsAPullRequest(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		issue map[string]any
		want  dashboard.ItemKind
	}{
		{"an issue", map[string]any{"number": 5, "body": "x", "state": "open"}, dashboard.ItemKindIssue},
		{"a pull request", map[string]any{"number": 5, "body": "x", "state": "open", "pull_request": map[string]any{"merged": false}}, dashboard.ItemKindPullRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			noReferences(t, mux)
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, tc.issue) })
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
			srv := httptest.NewServer(mux)
			defer srv.Close()

			got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Equal(t, tc.want, got.Kind)
		})
	}
}

// The header of a pull request opened from a reference needs its title, its
// author and whether it was merged, which only the forge knows.
func TestGetIssueDetails_APullRequestCarriesTheFactsItsHeaderNeeds(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		state string
		pr    map[string]any
		want  dashboard.ReferencedState
	}{
		{"open", "open", map[string]any{"merged": false}, dashboard.ReferencedStateOpen},
		{"closed", "closed", map[string]any{"merged": false}, dashboard.ReferencedStateClosed},
		{"merged", "closed", map[string]any{"merged": true}, dashboard.ReferencedStateMerged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			noReferences(t, mux)
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, map[string]any{
					"number": 5, "title": "Add structured logging", "body": "x", "state": tc.state, "pull_request": tc.pr,
					"user": map[string]any{"login": "claude", "avatar_url": "https://git.example.com/avatars/9"},
				})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
			srv := httptest.NewServer(mux)
			defer srv.Close()

			got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			require.NotNil(t, got.PullRequest)
			assert.Equal(t, "Add structured logging", got.PullRequest.Title)
			assert.Equal(t, tc.want, got.PullRequest.State)
			require.NotNil(t, got.PullRequest.Author)
			assert.Equal(t, "claude", got.PullRequest.Author.Login)
			assert.Equal(t, "https://git.example.com/avatars/9", got.PullRequest.Author.AvatarURL)
		})
	}
}

// A deleted account has no poster, so the header says no author instead of
// naming nobody.
func TestGetIssueDetails_APullRequestWithNoPosterHasNoAuthor(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	noReferences(t, mux)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "title": "Gone", "body": "x", "state": "open", "pull_request": map[string]any{"merged": false}, "user": nil})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.NotNil(t, got.PullRequest)
	assert.Nil(t, got.PullRequest.Author)
}

func refEvent(kind, action, repo string, number int, state string, merged bool) map[string]any {
	issue := map[string]any{
		"number": number, "title": fmt.Sprintf("Item %d", number), "state": state,
		"html_url":   fmt.Sprintf("https://git.example.com/%s/issues/%d", repo, number),
		"repository": map[string]any{"full_name": repo},
	}
	if kind == "pull_ref" {
		issue["pull_request"] = map[string]any{"merged": merged}
	}

	return map[string]any{"type": kind, "ref_action": action, "ref_issue": issue}
}

// What refers to an issue is on its timeline, so a closed issue has it whether
// or not the board lists it (#4271).
func TestGetIssueDetails_ReadsWhatReferToTheIssue(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "Done.", "state": "closed"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/timeline", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []any{})

			return
		}
		writeJSON(t, w, []any{
			map[string]any{"type": "comment", "body": "A comment"},
			refEvent("issue_ref", "neutered", "alrayyes/b", 3, "closed", false),
			refEvent("pull_ref", "closes", "alrayyes/a", 12, "closed", true),
			refEvent("commit_ref", "neutered", "alrayyes/a", 0, "open", false),
			refEvent("pull_ref", "neutered", "alrayyes/a", 13, "open", false),
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 3, "comments and commits are not references")
	// Newest first: the timeline lists oldest first.
	assert.Equal(t, 13, got.References[0].Number)
	assert.Equal(t, dashboard.ItemKindPullRequest, got.References[0].Kind)
	assert.Equal(t, dashboard.ReferencedStateOpen, got.References[0].State)
	assert.Equal(t, dashboard.RelationMentions, got.References[0].Relation)
	assert.Equal(t, 12, got.References[1].Number)
	assert.Equal(t, dashboard.ReferencedStateMerged, got.References[1].State)
	assert.Equal(t, dashboard.RelationCloses, got.References[1].Relation)
	assert.Equal(t, dashboard.ReferenceIncoming, got.References[1].Direction)
	assert.Equal(t, dashboard.ForgeForgejo, got.References[1].Forge)
	assert.Equal(t, "alrayyes/a", got.References[1].Repo)
	assert.Equal(t, "https://git.example.com/alrayyes/a/issues/12", got.References[1].URL)
	assert.Equal(t, 3, got.References[2].Number)
	assert.Equal(t, dashboard.ItemKindIssue, got.References[2].Kind)
	assert.Equal(t, dashboard.ReferencedStateClosed, got.References[2].State)
}

// issueWithTimeline serves alrayyes/a#5 with an empty thread and the given
// timeline handler.
func issueWithTimeline(t *testing.T, timeline http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "body": "Body.", "state": "open"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/timeline", timeline)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// The timeline only adds references, so a timeline that fails must not hide
// the description and comments (#4305).
func TestGetIssueDetails_ATimelineErrorLeavesTheIssueWithoutReferences(t *testing.T) {
	t.Parallel()

	for name, handler := range map[string]http.HandlerFunc{
		"server error": func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) },
		"bad body":     func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("not json")) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			srv := issueWithTimeline(t, handler)

			got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			assert.Equal(t, "Body.", got.Description.Text)
			assert.Empty(t, got.References)
		})
	}
}
