package forgejo_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
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

// A page that fails after others were read keeps what those pages held: the
// references are an addition, and a partial list beats none (#4322).
func TestGetIssueDetails_KeepsTheReferencesOfPagesReadBeforeAFailure(t *testing.T) {
	t.Parallel()

	for name, later := range map[string]http.HandlerFunc{
		"server error": func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) },
		"bad body":     func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("not json")) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			srv := issueWithTimeline(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("page") == "1" {
					writeJSON(t, w, []any{refEvent("pull_ref", "closes", "alrayyes/a", 12, "closed", true)})

					return
				}
				later(w, r)
			})

			got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

			require.NoError(t, err)
			require.Len(t, got.References, 1)
			assert.Equal(t, 12, got.References[0].Number)
		})
	}
}

// A cancelled read is not a timeline that is unavailable: the caller gave up,
// so the error reaches it instead of a thread that looks complete (#4322).
func TestGetIssueDetails_ACancelledContextIsAnError(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	srv := issueWithTimeline(t, func(w http.ResponseWriter, _ *http.Request) {
		cancel()
		writeJSON(t, w, []any{})
	})

	_, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(ctx, "alrayyes", "a", 5)

	require.ErrorIs(t, err, context.Canceled)
}

// The pages read before a failure all count, not just the last of them.
func TestGetIssueDetails_KeepsTheReferencesOfEveryPageReadBeforeAFailure(t *testing.T) {
	t.Parallel()

	srv := issueWithTimeline(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("page") {
		case "1":
			writeJSON(t, w, []any{refEvent("pull_ref", "closes", "alrayyes/a", 12, "closed", true)})
		case "2":
			writeJSON(t, w, []any{refEvent("pull_ref", "neutered", "alrayyes/a", 13, "open", false)})
		default:
			http.Error(w, "boom", http.StatusInternalServerError)
		}
	})

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 2)
	assert.Equal(t, 13, got.References[0].Number)
	assert.Equal(t, 12, got.References[1].Number)
}

// A caller that gives up part way through gets the error even though earlier
// pages held references: a partial list is for a forge failure, not a cancel.
func TestGetIssueDetails_ACancelDuringALaterPageIsAnError(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	srv := issueWithTimeline(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "1" {
			writeJSON(t, w, []any{refEvent("pull_ref", "closes", "alrayyes/a", 12, "closed", true)})

			return
		}
		cancel()
		writeJSON(t, w, []any{refEvent("pull_ref", "neutered", "alrayyes/a", 13, "open", false)})
	})

	_, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(ctx, "alrayyes", "a", 5)

	require.ErrorIs(t, err, context.Canceled)
}

// Forgejo drops rows it won't show after paging, so a short page is not the
// last one and a reference can sit on the page after it.
func TestGetIssueDetails_ReadsPastAShortTimelinePage(t *testing.T) {
	t.Parallel()

	srv := issueWithTimeline(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("page") {
		case "1":
			writeJSON(t, w, []any{map[string]any{"type": "comment", "body": "A comment"}})
		case "2":
			writeJSON(t, w, []any{refEvent("pull_ref", "closes", "alrayyes/a", 12, "closed", true)})
		default:
			writeJSON(t, w, []any{})
		}
	})

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 12, got.References[0].Number)
}

// Only a reference event is a reference, whatever else is on it.
func TestGetIssueDetails_IgnoresTimelineEventsThatAreNotReferences(t *testing.T) {
	t.Parallel()

	srv := issueWithTimeline(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []any{})

			return
		}
		events := []any{}
		for i, kind := range []string{"comment", "commit_ref", "label", "close", "commit"} {
			event := refEvent("issue_ref", "neutered", "alrayyes/b", 20+i, "open", false)
			event["type"] = kind
			events = append(events, event)
		}
		writeJSON(t, w, append(events, refEvent("comment_ref", "neutered", "alrayyes/b", 30, "open", false)))
	})

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 30, got.References[0].Number)
}

// The read stops after ten pages of fifty events. The timeline lists oldest
// first, so on a longer thread the newest references are the ones left out.
// The cap is documented in docs/rate-limits.md (#4305).
func TestGetIssueDetails_StopsReadingTheTimelineAtTenPages(t *testing.T) {
	t.Parallel()

	var pages atomic.Int32
	srv := issueWithTimeline(t, func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		pages.Add(1)
		events := []any{}
		for i := range 50 {
			events = append(events, refEvent("issue_ref", "neutered", "alrayyes/b", (page-1)*50+i+1, "open", false))
		}
		writeJSON(t, w, events)
	})

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.EqualValues(t, 10, pages.Load())
	require.NotEmpty(t, got.References)
	assert.Equal(t, 500, got.References[0].Number, "the newest reference read comes first")
}

// outgoingMux serves alrayyes/a#5 with the given description and nothing on its
// timeline, and each of items (keyed by the path after /api/v1/repos/) as the
// issue it names. A path not in items is a 404, which the mux gives itself.
func outgoingMux(t *testing.T, body string, pullRequest map[string]any, items map[string]map[string]any, asked *[]string) *http.ServeMux {
	t.Helper()

	mux := http.NewServeMux()
	noReferences(t, mux)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		issue := map[string]any{"number": 5, "title": "Show outgoing", "body": body, "state": "open"}
		if pullRequest != nil {
			issue["pull_request"] = pullRequest
		}
		writeJSON(t, w, issue)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/reactions", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5/comments", func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, []any{}) })
	for path, item := range items {
		mux.HandleFunc("/api/v1/repos/"+path, func(w http.ResponseWriter, _ *http.Request) {
			*asked = append(*asked, path)
			writeJSON(t, w, item)
		})
	}

	return mux
}

func namedItem(repo string, number int, title, state string, pullRequest map[string]any) map[string]any {
	item := map[string]any{
		"number": number, "title": title, "state": state,
		"html_url":   fmt.Sprintf("https://git.example.com/%s/issues/%d", repo, number),
		"repository": map[string]any{"full_name": repo},
	}
	if pullRequest != nil {
		item["pull_request"] = pullRequest
	}

	return item
}

// What the issue itself refers to is read from its text, and each named item
// is looked up for its state (#4272).
func TestGetIssueDetails_ReadsWhatTheIssueRefersTo(t *testing.T) {
	t.Parallel()

	var asked []string
	srv := httptest.NewServer(outgoingMux(t, "Refs #4271, alrayyes/b#4297. Also #9 and #404.", nil, map[string]map[string]any{
		"alrayyes/a/issues/4271": namedItem("alrayyes/a", 4271, "Closed issue", "closed", nil),
		"alrayyes/b/issues/4297": namedItem("alrayyes/b", 4297, "Merged pull request", "closed", map[string]any{"merged": true}),
		"alrayyes/a/issues/9":    namedItem("alrayyes/a", 9, "Nine", "open", nil),
	}, &asked))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 3, "#404 is not there and is left out")
	first, second, third := got.References[0], got.References[1], got.References[2]
	assert.Equal(t, 4271, first.Number)
	assert.Equal(t, dashboard.ReferenceOutgoing, first.Direction)
	assert.Equal(t, dashboard.RelationRefs, first.Relation)
	assert.Equal(t, dashboard.ReferencedStateClosed, first.State)
	assert.Equal(t, dashboard.ItemKindIssue, first.Kind)
	assert.Equal(t, dashboard.ForgeForgejo, first.Forge)
	assert.Equal(t, "Closed issue", first.Title)
	assert.Equal(t, "alrayyes/b", second.Repo)
	assert.Equal(t, dashboard.ItemKindPullRequest, second.Kind)
	assert.Equal(t, dashboard.ReferencedStateMerged, second.State)
	assert.Equal(t, "https://git.example.com/alrayyes/b/issues/4297", second.URL)
	assert.Equal(t, dashboard.RelationMentions, third.Relation)
	assert.Equal(t, dashboard.ReferencedStateOpen, third.State)
}

func TestGetIssueDetails_AnOpenPullRequestItNamesIsOpen(t *testing.T) {
	t.Parallel()

	var asked []string
	srv := httptest.NewServer(outgoingMux(t, "See #9", nil, map[string]map[string]any{
		"alrayyes/a/issues/9": namedItem("alrayyes/a", 9, "Nine", "open", map[string]any{"merged": false}),
	}, &asked))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, dashboard.ItemKindPullRequest, got.References[0].Kind)
	assert.Equal(t, dashboard.ReferencedStateOpen, got.References[0].State)
}

func TestGetIssueDetails_NamingNothingAsksNothing(t *testing.T) {
	t.Parallel()

	var asked []string
	srv := httptest.NewServer(outgoingMux(t, "Nothing to see.", nil, nil, &asked))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Empty(t, got.References)
	assert.Empty(t, asked)
}

// A lookup that fails outright, as the forge's error and not as a missing item,
// leaves the thread as it was.
func TestGetIssueDetails_AFailedLookupLeavesTheThread(t *testing.T) {
	t.Parallel()

	var asked []string
	mux := outgoingMux(t, "See #9", nil, nil, &asked)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/9", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Equal(t, "See #9", got.Description.Text)
	assert.Empty(t, got.References)
}

// A pull request closes what it says it closes.
func TestGetIssueDetails_APullRequestListsWhatItCloses(t *testing.T) {
	t.Parallel()

	var asked []string
	mux := outgoingMux(t, "Closes #9", map[string]any{"merged": false}, map[string]map[string]any{
		"alrayyes/a/issues/9": namedItem("alrayyes/a", 9, "Nine", "open", nil),
	}, &asked)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, dashboard.RelationCloses, got.References[0].Relation)
}

// A missing item is skipped and the ones after it are still read.
func TestGetIssueDetails_AMissingItemDoesNotStopTheRest(t *testing.T) {
	t.Parallel()

	var asked []string
	srv := httptest.NewServer(outgoingMux(t, "See #404, #9", nil, map[string]map[string]any{
		"alrayyes/a/issues/9": namedItem("alrayyes/a", 9, "Nine", "open", nil),
	}, &asked))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 9, got.References[0].Number)
}

// When the forge itself fails, the lookups stop and what was found stays.
func TestGetIssueDetails_AForgeFailureKeepsWhatWasFound(t *testing.T) {
	t.Parallel()

	var asked []string
	mux := outgoingMux(t, "See #8, #9, #10", nil, map[string]map[string]any{
		"alrayyes/a/issues/8":  namedItem("alrayyes/a", 8, "Eight", "open", nil),
		"alrayyes/a/issues/10": namedItem("alrayyes/a", 10, "Ten", "open", nil),
	}, &asked)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/9", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 8, got.References[0].Number)
	assert.NotContains(t, asked, "alrayyes/a/issues/10", "no more lookups once the forge fails")
}

func TestGetIssueDetails_TheTitleCountsForWhatItRefersTo(t *testing.T) {
	t.Parallel()

	var asked []string
	mux := outgoingMux(t, "", nil, map[string]map[string]any{
		"alrayyes/a/issues/9": namedItem("alrayyes/a", 9, "Nine", "open", nil),
	}, &asked)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	// outgoingMux gives the issue a fixed title, so the title case is its own
	// server.
	titled := http.NewServeMux()
	titled.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "title": "Follow up #9", "body": "", "state": "open"})
	})
	titled.Handle("/", mux)
	titledSrv := httptest.NewServer(titled)
	defer titledSrv.Close()

	got, err := forgejo.NewClient(titledSrv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 9, got.References[0].Number)
}

// A link to an item on the saved instance is read as the item.
func TestGetIssueDetails_ALinkToAnItemOnTheInstanceIsNamed(t *testing.T) {
	t.Parallel()

	var asked []string
	var base string
	mux := http.NewServeMux()
	inner := outgoingMux(t, "", nil, map[string]map[string]any{
		"alrayyes/b/issues/4297": namedItem("alrayyes/b", 4297, "Fix", "open", nil),
	}, &asked)
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "title": "T", "body": "See " + base + "/alrayyes/b/pulls/4297", "state": "open"})
	})
	mux.Handle("/", inner)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	base = srv.URL

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, 4297, got.References[0].Number)
}

// The repository is spelled as Forgejo spells it, not as the text did.
func TestGetIssueDetails_TheTargetsRepoIsTheForgesSpelling(t *testing.T) {
	t.Parallel()

	var asked []string
	srv := httptest.NewServer(outgoingMux(t, "See alrayyes/b#5", nil, map[string]map[string]any{
		"alrayyes/b/issues/5": namedItem("AlRayyes/B", 5, "Five", "open", nil),
	}, &asked))
	defer srv.Close()

	got, err := forgejo.NewClient(srv.URL, "test-token", "").GetIssueDetails(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, got.References, 1)
	assert.Equal(t, "AlRayyes/B", got.References[0].Repo)
}
