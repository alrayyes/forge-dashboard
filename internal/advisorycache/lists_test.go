package advisorycache_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/advisorycache"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type tick struct{ t time.Time }

func (c *tick) now() time.Time { return c.t }

func known(summary string) dashboard.AdvisoryList {
	return dashboard.AdvisoryList{
		State:      dashboard.AdvisoriesKnown,
		Advisories: []dashboard.AdvisoryItem{{Number: 1, State: "open", Summary: summary}},
	}
}

// reader counts its calls and answers with what the test last set.
type reader struct {
	calls int
	list  dashboard.AdvisoryList
	err   error
}

func (r *reader) read(context.Context) (dashboard.AdvisoryList, error) {
	r.calls++

	return r.list, r.err
}

func newLists() (*advisorycache.Lists, *tick) {
	clk := &tick{t: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)}

	return &advisorycache.Lists{Now: clk.now}, clk
}

func TestLists_AnOpenWithinTheTTLReadsNothing(t *testing.T) {
	t.Parallel()
	lists, clk := newLists()
	r := &reader{list: known("a")}

	first, err := lists.Serve(t.Context(), "k", r.read)
	require.NoError(t, err)
	clk.t = clk.t.Add(14 * time.Minute)
	second, err := lists.Serve(t.Context(), "k", r.read)
	require.NoError(t, err)

	assert.Equal(t, 1, r.calls)
	assert.Equal(t, "2026-11-17T12:00:00Z", first.ReadAt)
	assert.Equal(t, first, second, "the same read time, so a client can tell a repeat from a change")
}

func TestLists_AnOpenAfterTheTTLReadsAgain(t *testing.T) {
	t.Parallel()
	lists, clk := newLists()
	r := &reader{list: known("a")}
	_, _ = lists.Serve(t.Context(), "k", r.read)
	clk.t = clk.t.Add(16 * time.Minute)

	got, err := lists.Serve(t.Context(), "k", r.read)

	require.NoError(t, err)
	assert.Equal(t, 2, r.calls)
	assert.Equal(t, "2026-11-17T12:16:00Z", got.ReadAt)
}

func TestLists_AFreshReadSkipsTheKeptList(t *testing.T) {
	t.Parallel()
	lists, _ := newLists()
	r := &reader{list: known("a")}
	_, _ = lists.Serve(t.Context(), "k", r.read)
	r.list = known("b")

	got, err := lists.Serve(dashboard.WithFreshAdvisories(t.Context()), "k", r.read)

	require.NoError(t, err)
	assert.Equal(t, 2, r.calls)
	assert.Equal(t, "b", got.Advisories[0].Summary)
}

func TestLists_AFailedOrThrottledRefreshKeepsTheLastGoodListAndSaysSo(t *testing.T) {
	t.Parallel()
	for name, fail := range map[string]*reader{
		"failed":    {list: dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}},
		"throttled": {list: dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonThrottled}},
		"an error":  {err: errors.New("boom")},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			lists, clk := newLists()
			good := &reader{list: known("a")}
			_, _ = lists.Serve(t.Context(), "k", good.read)
			clk.t = clk.t.Add(time.Hour)

			got, err := lists.Serve(t.Context(), "k", fail.read)

			require.NoError(t, err)
			assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
			require.Len(t, got.Advisories, 1, "never an empty list")
			assert.Equal(t, "2026-11-17T12:00:00Z", got.ReadAt, "the old read time says how old it is")
			if name == "an error" {
				assert.Equal(t, dashboard.ReasonFailed, got.RefreshFailed)
			} else {
				assert.Equal(t, fail.list.Reason, got.RefreshFailed)
			}
		})
	}
}

func TestLists_ARefusalReplacesAGoodList(t *testing.T) {
	t.Parallel()
	lists, _ := newLists()
	r := &reader{list: known("a")}
	_, _ = lists.Serve(t.Context(), "k", r.read)
	r.list = dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonSwitchedOff}

	got, err := lists.Serve(dashboard.WithFreshAdvisories(t.Context()), "k", r.read)

	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Empty(t, got.RefreshFailed)
}

func TestLists_AColdFailureIsTheFailureNotAnEmptyKnownList(t *testing.T) {
	t.Parallel()
	lists, _ := newLists()
	r := &reader{list: dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}}

	got, err := lists.Serve(t.Context(), "k", r.read)
	require.NoError(t, err)
	_, _ = lists.Serve(t.Context(), "k", r.read)

	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Equal(t, 2, r.calls, "a failure is not kept: the next open asks again")
}

func TestLists_KeepsNoMoreThanMaxListsAndTheNewestSurvives(t *testing.T) {
	t.Parallel()
	lists, _ := newLists()

	for i := range advisorycache.MaxLists + 1 {
		lists.Put(fmt.Sprintf("repo-%d", i), known("a"), advisorycache.TTL)
	}

	kept := 0
	for i := range advisorycache.MaxLists + 1 {
		if _, _, ok := lists.Get(fmt.Sprintf("repo-%d", i)); ok {
			kept++
		}
	}
	assert.LessOrEqual(t, kept, advisorycache.MaxLists)
	_, _, ok := lists.Get(fmt.Sprintf("repo-%d", advisorycache.MaxLists))
	assert.True(t, ok, "the list just written is kept")
}
