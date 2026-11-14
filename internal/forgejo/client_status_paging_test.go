package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// statusPageSize is the page size the fake forge answers with, whatever limit
// is asked for, the way Forgejo's default page is 30.
const statusPageSize = 30

type pagedForge struct {
	// statuses is every status of the commit, in the order the forge pages them.
	statuses []map[string]string
	// stateOf is the combined state the forge reports for one page of them.
	stateOf func(page []map[string]string) string
	// failPage is a page the forge answers with a 500, or 0 for none.
	failPage int
	// pageSize is how many statuses the forge puts on a page, or 0 for
	// statusPageSize.
	pageSize int
	// totalHeader is the X-Total-Count the forge sends, or nil for the true
	// number. An empty string sends no header.
	totalHeader *string
}

func statusesOf(n int, state string) []map[string]string {
	out := make([]map[string]string, 0, n)
	for i := range n {
		out = append(out, map[string]string{"status": state, "context": "ci/" + strconv.Itoa(i) + "/" + state})
	}

	return out
}

// serve starts the fake forge and returns its client and a counter of the
// combined-status requests it has answered.
func (f pagedForge) serve(t *testing.T) (*forgejo.Client, *atomic.Int32) {
	client, reads, _ := f.serveRecorded(t)

	return client, reads
}

// serveRecorded is serve, and also returns the raw query of every
// combined-status request, in the order they came.
func (f pagedForge) serveRecorded(t *testing.T) (*forgejo.Client, *atomic.Int32, func() []string) {
	t.Helper()
	reads := &atomic.Int32{}
	var mu sync.Mutex
	var queries []string
	size := statusPageSize
	if f.pageSize > 0 {
		size = f.pageSize
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 12, "title": "t", "html_url": "https://git.example/alrayyes/a/pulls/12",
			"user": map[string]string{"login": "ryankes"}, "labels": []map[string]string{}, "mergeable": true,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"sha": "abc"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		mu.Lock()
		queries = append(queries, r.URL.RawQuery)
		mu.Unlock()
		page, err := strconv.Atoi(r.URL.Query().Get("page"))
		if err != nil || page < 1 {
			page = 1
		}
		if page == f.failPage {
			w.WriteHeader(http.StatusInternalServerError)

			return
		}
		from := min((page-1)*size, len(f.statuses))
		chunk := f.statuses[from:min(from+size, len(f.statuses))]
		switch {
		case f.totalHeader == nil:
			w.Header().Set("X-Total-Count", strconv.Itoa(len(f.statuses)))
		case *f.totalHeader != "":
			w.Header().Set("X-Total-Count", *f.totalHeader)
		}
		writeJSON(t, w, map[string]any{"state": f.stateOf(chunk), "statuses": chunk, "total_count": len(chunk)})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	recorded := func() []string {
		mu.Lock()
		defer mu.Unlock()

		return slices.Clone(queries)
	}

	return forgejo.NewClient(srv.URL, "test-token", ""), reads, recorded
}

func (f pagedForge) pullRequest(t *testing.T) (dashboard.PullRequest, *atomic.Int32) {
	t.Helper()
	client, reads := f.serve(t)
	prs, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 1)

	return prs[0], reads
}

func pendingState([]map[string]string) string { return "pending" }

// A commit with more statuses than one page holds (30 here, X-Total-Count 31)
// is tallied in full, one request per page and no more (#3248).
func TestListOpenPullRequests_CountsStatusesAcrossPages(t *testing.T) {
	t.Parallel()
	statuses := append(statusesOf(30, "success"), statusesOf(1, "pending")...)

	got, reads := pagedForge{statuses: statuses, stateOf: pendingState}.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 30, Waiting: 1}, got.Checks)
	assert.EqualValues(t, 2, reads.Load(), "one status request per page")
}

// A commit that fits one page costs the one request it always did.
func TestListOpenPullRequests_OnePageOfStatusesIsOneRequest(t *testing.T) {
	t.Parallel()

	_, reads := pagedForge{statuses: statusesOf(5, "success"), stateOf: pendingState}.pullRequest(t)

	assert.EqualValues(t, 1, reads.Load())
}

// The combined state may be worked out per page, so a failing status on the
// second page must still fail the row, and be counted.
func TestListOpenPullRequests_AFailingStatusOnALaterPageFailsTheRow(t *testing.T) {
	t.Parallel()
	statuses := append(statusesOf(30, "success"), statusesOf(1, "failure")...)
	stateOf := func(page []map[string]string) string {
		if len(page) > 0 && page[0]["status"] == "failure" {
			return "failure"
		}

		return "success"
	}

	got, _ := pagedForge{statuses: statuses, stateOf: stateOf}.pullRequest(t)

	assert.Equal(t, dashboard.CIFailure, got.CI)
}

func TestListOpenPullRequests_AFailingStatusOnALaterPageIsCounted(t *testing.T) {
	t.Parallel()
	statuses := append(statusesOf(30, "success"), statusesOf(1, "failure")...)

	got, _ := pagedForge{statuses: statuses, stateOf: pendingState}.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 30, Failed: 1}, got.Checks)
}

// A page that can't be read leaves the counts unknown rather than short, and
// the row keeps the combined state of the first page.
func TestListOpenPullRequests_ALaterPageThatFailsLeavesTheCountsUnknown(t *testing.T) {
	t.Parallel()
	statuses := append(statusesOf(30, "success"), statusesOf(1, "pending")...)

	got, _ := pagedForge{statuses: statuses, stateOf: pendingState, failPage: 2}.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{}, got.Checks)
}

func TestListOpenPullRequests_ALaterPageThatFailsKeepsTheFirstPagesState(t *testing.T) {
	t.Parallel()
	statuses := append(statusesOf(30, "success"), statusesOf(1, "pending")...)

	got, _ := pagedForge{statuses: statuses, stateOf: pendingState, failPage: 2}.pullRequest(t)

	assert.Equal(t, dashboard.CIPending, got.CI)
}

// The walk reads at most 20 pages of 50, so 1000 statuses are the most it
// tallies. One more and the counts would undercount, so they are dropped while
// the combined state stays.
func TestListOpenPullRequests_ThousandStatusesAreCounted(t *testing.T) {
	t.Parallel()

	got, reads := pagedForge{statuses: statusesOf(1000, "success"), stateOf: pendingState, pageSize: 50}.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1000}, got.Checks)
	assert.EqualValues(t, 20, reads.Load())
}

func TestListOpenPullRequests_MoreThanAThousandStatusesZeroTheCountsAndKeepTheState(t *testing.T) {
	t.Parallel()

	got, reads := pagedForge{statuses: statusesOf(1001, "success"), stateOf: pendingState, pageSize: 50}.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{}, got.Checks)
	assert.Equal(t, dashboard.CIPending, got.CI)
	assert.EqualValues(t, 20, reads.Load(), "the walk stops at the page cap")
}

// A forge that sends no X-Total-Count, or one that isn't a number, gives the
// walk no total to go on: it reads the first page and takes it as the whole.
func TestListOpenPullRequests_AFullFirstPageWithoutAUsableTotalIsTakenAsWhole(t *testing.T) {
	t.Parallel()
	for name, header := range map[string]string{"missing": "", "garbage": "lots"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			statuses := append(statusesOf(30, "success"), statusesOf(1, "pending")...)

			got, reads := pagedForge{statuses: statuses, stateOf: pendingState, totalHeader: &header}.pullRequest(t)

			assert.Equal(t, dashboard.CheckCounts{Passed: 30}, got.Checks)
			assert.EqualValues(t, 1, reads.Load())
		})
	}
}

// The first page is the one that can't be skipped: without it the row has no
// state and no counts at all.
func TestListOpenPullRequests_APageOneThatFailsLeavesNoStateAndNoCounts(t *testing.T) {
	t.Parallel()

	got, _ := pagedForge{statuses: statusesOf(5, "success"), stateOf: pendingState, failPage: 1}.pullRequest(t)

	assert.Equal(t, dashboard.CINone, got.CI)
	assert.Equal(t, dashboard.CheckCounts{}, got.Checks)
}

// A total higher than what the forge holds can't loop the walk: an empty page
// ends it, and what was read stands as whole.
func TestListOpenPullRequests_EmptyLaterPagesEndAWalkWhoseTotalIsTooHigh(t *testing.T) {
	t.Parallel()
	total := "500"
	statuses := append(statusesOf(30, "success"), statusesOf(1, "pending")...)

	got, reads := pagedForge{statuses: statuses, stateOf: pendingState, totalHeader: &total}.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 30, Waiting: 1}, got.Checks)
	assert.EqualValues(t, 3, reads.Load(), "pages 1 and 2 hold statuses, page 3 is empty")
}

// Every request asks for 50 to a page. The fake forge ignores it, so the
// request itself is the only place to see it.
func TestListOpenPullRequests_StatusRequestsAskForFiftyAPage(t *testing.T) {
	t.Parallel()
	statuses := append(statusesOf(30, "success"), statusesOf(1, "pending")...)
	client, _, queries := pagedForge{statuses: statuses, stateOf: pendingState}.serveRecorded(t)

	_, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)

	assert.Equal(t, []string{"page=1&limit=50", "page=2&limit=50"}, queries())
}
