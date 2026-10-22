package dashboard

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func staleSnapshot(stale, failing *time.Time) Snapshot {
	return Snapshot{
		Forges: []ForgeHealth{{Forge: ForgeGitHub, Reachable: true}},
		Repos: []Repo{
			{Forge: ForgeGitHub, FullName: "o/a", HasWebhook: true},
			{Forge: ForgeGitHub, FullName: "o/b", HasWebhook: true, StaleSince: stale, FailingSince: failing},
		},
	}
}

func TestWebhooksCover_ARepoStopsHoldingTheWaitThreeIntervalsAfterItsFirstFailure(t *testing.T) {
	t.Parallel()

	const interval = 20 * time.Minute
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name    string
		failing time.Duration
		want    bool
	}{
		{"just failed", 0, false},
		{"two intervals in", 2 * interval, false},
		{"just under three", 3*interval - time.Second, false},
		{"three intervals in", 3 * interval, true},
		{"a long outage", 10 * interval, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			// Its rows are from long before: the last good fetch says nothing
			// about when the failure began.
			stale := now.Add(-24 * time.Hour)
			failing := now.Add(-tt.failing)
			assert.Equal(t, tt.want, webhooksCover(staleSnapshot(&stale, &failing), interval, now))
		})
	}
}

func TestWebhooksCover_AStaleRepoWithNoFailureTimeStillHoldsTheWait(t *testing.T) {
	t.Parallel()

	// A snapshot restored from the cache knows when the rows were fetched,
	// not when the failure began.
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	stale := now.Add(-24 * time.Hour)

	assert.False(t, webhooksCover(staleSnapshot(&stale, nil), 20*time.Minute, now))
}

type failingRepoSource struct{ result Result }

func (s *failingRepoSource) Fetch(context.Context) Result { return s.result }
func (s *failingRepoSource) Forge() Forge                 { return ForgeGitHub }

func TestAggregator_FailingSinceStartsAtTheFirstFailureAndSurvivesMore(t *testing.T) {
	t.Parallel()

	healthy := Result{
		Health: ForgeHealth{Forge: ForgeGitHub, Reachable: true},
		Repos:  []Repo{{Forge: ForgeGitHub, FullName: "o/b", HasWebhook: true}},
	}
	failing := healthy
	failing.FailedRepos = []FailedRepo{{FullName: "o/b", Issues: true}}
	src := &failingRepoSource{result: healthy}
	agg := NewAggregator([]Source{src})
	agg.Refresh(t.Context())

	src.result = failing
	before := time.Now().UTC()
	agg.Refresh(t.Context())
	first := agg.Get().Repos[0]
	require.NotNil(t, first.FailingSince)
	assert.False(t, first.FailingSince.Before(before), "the failure starts now, not at the last good fetch")

	agg.Refresh(t.Context())
	assert.Equal(t, first.FailingSince, agg.Get().Repos[0].FailingSince, "a second failure keeps the first one's time")

	src.result = healthy
	agg.Refresh(t.Context())
	assert.Nil(t, agg.Get().Repos[0].FailingSince)
}

func TestMergePendingResult_KeepsARepoStaleBecauseItFetchedNoIssues(t *testing.T) {
	t.Parallel()

	at := time.Now().Add(-time.Hour).UTC()
	failing := time.Now().Add(-time.Minute).UTC()
	agg := NewAggregator(nil)
	agg.snap = staleSnapshot(&at, &failing)
	agg.snap.PullRequests = []PullRequest{{Forge: ForgeGitHub, Repo: "o/b", Number: 1}}

	agg.mergePendingResult(t.Context(), ForgeGitHub, 1, PendingResult{Closed: []PullRequestRef{{FullName: "o/b", Number: 1}}})

	repo := agg.Get().Repos[1]
	assert.Equal(t, &at, repo.StaleSince, "a CI poll fetched no issues, so the repo is as stale as before")
	assert.Equal(t, &failing, repo.FailingSince)
}
