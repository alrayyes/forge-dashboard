package forgejo_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func timelineEvent(kind string) map[string]any {
	return map[string]any{"type": kind, "user": map[string]string{"login": "alrayyes"}}
}

// timelineServer serves open pulls and, for each number in timelines, its
// timeline events. A number missing from timelines answers 500. fail, when
// set, makes every timeline request answer 500 instead.
func timelineServer(t *testing.T, prs []map[string]any, timelines map[int][]map[string]any, calls *atomic.Int32, fail *atomic.Bool) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, prs)
	})
	for _, p := range prs {
		n := p["number"].(int)
		mux.HandleFunc(fmt.Sprintf("/api/v1/repos/alrayyes/a/pulls/%d/reviews", n), func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, []map[string]any{})
		})
		mux.HandleFunc(fmt.Sprintf("/api/v1/repos/alrayyes/a/issues/%d/timeline", n), func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			events, ok := timelines[n]
			if !ok || (fail != nil && fail.Load()) {
				http.Error(w, `{"message":"boom"}`, http.StatusInternalServerError)

				return
			}
			if page := r.URL.Query().Get("page"); page != "" && page != "1" {
				writeJSON(t, w, []map[string]any{})

				return
			}
			writeJSON(t, w, events)
		})
	}

	return httptest.NewServer(mux)
}

func TestListOpenPullRequests_ReadsAForgeScheduledMergeFromTheTimeline(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := timelineServer(t,
		[]map[string]any{
			reviewPR(1, false, "2026-09-02T00:00:00Z"),
			reviewPR(2, false, "2026-09-02T00:00:00Z"),
			reviewPR(3, false, "2026-09-02T00:00:00Z"),
			reviewPR(4, false, "2026-09-02T00:00:00Z"),
		},
		map[int][]map[string]any{
			1: {timelineEvent("comment"), timelineEvent("pull_scheduled_merge")},
			2: {timelineEvent("pull_scheduled_merge"), timelineEvent("pull_cancel_scheduled_merge")},
			3: {timelineEvent("comment")},
			4: {timelineEvent("pull_scheduled_merge"), timelineEvent("pull_cancel_scheduled_merge"), timelineEvent("pull_scheduled_merge")},
		}, &calls, nil)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 4)

	require.NotNil(t, prs[0].AutoMergeEnabled)
	assert.True(t, *prs[0].AutoMergeEnabled, "a schedule with no later cancel is auto-merging")
	require.NotNil(t, prs[1].AutoMergeEnabled)
	assert.False(t, *prs[1].AutoMergeEnabled, "a cancel after the schedule turns it off")
	require.NotNil(t, prs[2].AutoMergeEnabled)
	assert.False(t, *prs[2].AutoMergeEnabled, "never scheduled is off")
	require.NotNil(t, prs[3].AutoMergeEnabled)
	assert.True(t, *prs[3].AutoMergeEnabled, "the latest of the two decides")
}

func TestListOpenPullRequests_SkipsTheTimelineWhereItCannotMatter(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := timelineServer(t,
		[]map[string]any{reviewPR(1, true, "2026-09-02T00:00:00Z")},
		map[int][]map[string]any{1: {timelineEvent("pull_scheduled_merge")}}, &calls, nil)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 1)

	assert.Nil(t, prs[0].AutoMergeEnabled, "a draft stays unknown")
	assert.Zero(t, calls.Load(), "a draft costs no timeline request")
}

func TestListOpenPullRequests_KeepsTheLastKnownScheduleWhenTheTimelineFails(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	var fail atomic.Bool
	srv := timelineServer(t,
		[]map[string]any{reviewPR(1, false, "2026-09-02T00:00:00Z"), reviewPR(2, false, "2026-09-02T00:00:00Z")},
		map[int][]map[string]any{1: {timelineEvent("pull_scheduled_merge")}, 2: {}}, &calls, &fail)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	first, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.NotNil(t, first[0].AutoMergeEnabled)
	require.True(t, *first[0].AutoMergeEnabled)

	fail.Store(true)
	second, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err, "a failed timeline read must not fail the refresh")
	require.Len(t, second, 2)
	require.NotNil(t, second[0].AutoMergeEnabled)
	assert.True(t, *second[0].AutoMergeEnabled, "the last known value survives one failure")
	require.NotNil(t, second[1].AutoMergeEnabled)
	assert.False(t, *second[1].AutoMergeEnabled)
}

func TestListOpenPullRequests_UnknownStaysUnknownWhenTheFirstTimelineReadFails(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := timelineServer(t,
		[]map[string]any{reviewPR(1, false, "2026-09-02T00:00:00Z")},
		map[int][]map[string]any{}, &calls, nil)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Nil(t, prs[0].AutoMergeEnabled, "unknown, not off")
}

func TestListOpenPullRequests_ReadsAtMostEightTimelinesAndRotatesThroughTheRest(t *testing.T) {
	t.Parallel()

	var prs []map[string]any
	timelines := map[int][]map[string]any{}
	for n := 1; n <= 12; n++ {
		prs = append(prs, reviewPR(n, false, "2026-09-02T00:00:00Z"))
		timelines[n] = []map[string]any{timelineEvent("pull_scheduled_merge")}
	}
	var calls atomic.Int32
	srv := timelineServer(t, prs, timelines, &calls, nil)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	first, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	// Each timeline is two requests: its page, and the empty page that ends the read.
	assert.Equal(t, int32(16), calls.Load(), "the first refresh reads the cap of eight timelines and no more")

	second, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	assert.Equal(t, int32(32), calls.Load(), "the next refresh reads the four it skipped first, then the oldest four")

	known := func(list []dashboard.PullRequest) int {
		n := 0
		for _, p := range list {
			if p.AutoMergeEnabled != nil {
				n++
			}
		}

		return n
	}
	assert.Equal(t, 8, known(first))
	assert.Equal(t, 12, known(second))
}

func TestListOpenPullRequests_StopsReadingTheTimelineOfAPullRequestThatClosed(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	open := []map[string]any{reviewPR(1, false, "2026-09-02T00:00:00Z")}
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, open)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/1/reviews", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/1/timeline", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("page") != "" && r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{timelineEvent("pull_scheduled_merge")})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	_, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	mu.Lock()
	open = nil
	mu.Unlock()
	_, err = client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	assert.Equal(t, int32(2), calls.Load(), "one read (a page and the empty one), and none once the pull request closed")
}

func TestDisableAutoMerge_CancelsTheScheduleOnTheForge(t *testing.T) {
	t.Parallel()

	for name, status := range map[string]int{"cancelled": http.StatusNoContent, "nothing scheduled": http.StatusNotFound, "conflict": http.StatusConflict} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			var method, path string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				method, path = r.Method, r.URL.Path
				w.WriteHeader(status)
			}))
			defer srv.Close()

			client := forgejo.NewClient(srv.URL, "test-token", "")
			require.NoError(t, client.DisableAutoMerge(t.Context(), "alrayyes", "a", 7))
			assert.Equal(t, http.MethodDelete, method)
			assert.Equal(t, "/api/v1/repos/alrayyes/a/pulls/7/merge", path)
		})
	}
}

func TestDisableAutoMerge_ReportsOtherRefusals(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	require.Error(t, client.DisableAutoMerge(t.Context(), "alrayyes", "a", 7))
}

// Forgejo pages a timeline in the database query and then drops the rows it
// won't show (review line comments, references it can't read), so a page can
// come back short while later pages exist, and the cancel that turns the
// schedule off sits on one of them (it pages oldest first). A short page is
// not the last one.
func TestListOpenPullRequests_ReadsPastAShortTimelinePage(t *testing.T) {
	t.Parallel()

	for name, total := range map[string]string{
		"the forge reports how many rows exist": "120",
		"the forge reports no count":            "",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("page") != "1" {
					writeJSON(t, w, []map[string]any{})

					return
				}
				writeJSON(t, w, []map[string]any{reviewPR(1, false, "2026-09-02T00:00:00Z")})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/1/reviews", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, []map[string]any{})
			})
			mux.HandleFunc("/api/v1/repos/alrayyes/a/issues/1/timeline", func(w http.ResponseWriter, r *http.Request) {
				if total != "" {
					w.Header().Set("X-Total-Count", total)
				}
				switch r.URL.Query().Get("page") {
				case "1":
					writeJSON(t, w, []map[string]any{timelineEvent("comment"), timelineEvent("pull_scheduled_merge")})
				case "2":
					writeJSON(t, w, []map[string]any{timelineEvent("pull_cancel_scheduled_merge")})
				default:
					writeJSON(t, w, []map[string]any{})
				}
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			client := forgejo.NewClient(srv.URL, "test-token", "")
			prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
			require.NoError(t, err)
			require.Len(t, prs, 1)

			require.NotNil(t, prs[0].AutoMergeEnabled)
			assert.False(t, *prs[0].AutoMergeEnabled, "the cancel on page 2 turns the schedule off")
		})
	}
}

func TestListOpenPullRequests_ScheduledMergeIsHeldByTheForge(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	var fail atomic.Bool
	srv := timelineServer(t,
		[]map[string]any{reviewPR(1, false, "2026-09-02T00:00:00Z"), reviewPR(2, false, "2026-09-02T00:00:00Z"), reviewPR(3, true, "2026-09-02T00:00:00Z")},
		map[int][]map[string]any{1: {timelineEvent("pull_scheduled_merge")}, 2: {timelineEvent("comment")}, 3: {}}, &calls, &fail)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	first, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AutoMergeHeldByForge, first[0].AutoMergeHeldBy)
	assert.Empty(t, first[1].AutoMergeHeldBy, "not scheduled has no holder")
	assert.Empty(t, first[2].AutoMergeHeldBy, "unknown has no holder")

	fail.Store(true)
	second, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AutoMergeHeldByForge, second[0].AutoMergeHeldBy, "a failed read keeps the last known holder")
	assert.Empty(t, second[1].AutoMergeHeldBy)
}
