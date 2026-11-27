package dashboard_test

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// settledSource is a Forgejo source whose rows and newest status id a test sets.
// It counts the status probes and the repo reads it is asked for.
type settledSource struct {
	mu       sync.Mutex
	rows     []dashboard.PullRequest
	latest   int64
	health   dashboard.ForgeHealth
	repoErr  error
	onRepo   func()
	probes   int
	repoRead int
}

func (s *settledSource) Forge() dashboard.Forge { return dashboard.ForgeForgejo }

func (s *settledSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	health := s.health
	health.Forge, health.Reachable = dashboard.ForgeForgejo, true

	return dashboard.Result{Health: health, PullRequests: slices.Clone(s.rows)}
}

func (s *settledSource) FetchRepo(context.Context, string, string, string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.repoRead++
	if s.repoErr != nil {
		return nil, nil, s.repoErr
	}
	if s.onRepo != nil {
		s.onRepo()
	}

	return slices.Clone(s.rows), nil, nil
}

func (s *settledSource) LatestStatusID(context.Context, string, string, string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.probes++

	return s.latest, nil
}

func (s *settledSource) counts() (probes, repoReads int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.probes, s.repoRead
}

func settledRow(number int, ci dashboard.CIStatus) dashboard.PullRequest {
	return dashboard.PullRequest{
		Forge: dashboard.ForgeForgejo, Repo: "alrayyes/tempus-fugit", Number: number,
		CI: ci, HeadSHA: "cafef00d", LatestStatusID: 1,
	}
}

func settledAggregator(t *testing.T, s *settledSource, opts ...dashboard.AggregatorOption) *dashboard.Aggregator {
	t.Helper()
	opts = append(opts, dashboard.WithCIPollInterval(time.Minute))
	agg := dashboard.NewAggregator([]dashboard.Source{s}, opts...)
	agg.Refresh(t.Context())

	return agg
}

func TestPollCI_SettledRowsThatAreProbed(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		ci     dashboard.CIStatus
		probes int
	}{
		"failed":    {dashboard.CIFailure, 1},
		"cancelled": {dashboard.CICancelled, 1},
		"passed":    {dashboard.CISuccess, 0},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			source := &settledSource{rows: []dashboard.PullRequest{settledRow(7, tc.ci)}, latest: 1}
			agg := settledAggregator(t, source)

			agg.PollCI(t.Context())

			probes, _ := source.counts()
			assert.Equal(t, tc.probes, probes)
		})
	}
}

func TestPollCI_FailedRowOnAForgeHoldingItsBudget_IsNotProbed(t *testing.T) {
	t.Parallel()
	source := &settledSource{
		rows:   []dashboard.PullRequest{settledRow(7, dashboard.CIFailure)},
		latest: 2,
		health: dashboard.ForgeHealth{RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 1, ResetsAt: time.Now().Add(time.Hour)}},
	}
	agg := settledAggregator(t, source)

	agg.PollCI(t.Context())

	probes, _ := source.counts()
	assert.Zero(t, probes)
}

func TestPollCI_NewerStatusWhoseRepoCannotBeRead_BacksOff(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	source := &settledSource{rows: []dashboard.PullRequest{settledRow(7, dashboard.CIFailure)}, latest: 2}
	agg := settledAggregator(t, source, dashboard.WithClock(func() time.Time { return now }))
	source.repoErr = errors.New("listing failed")

	for range 60 {
		agg.PollCI(t.Context())
		now = now.Add(time.Minute)
	}

	_, repoReads := source.counts()
	assert.LessOrEqual(t, repoReads, 15, "an hour of one-minute ticks")
}

func TestPollCI_RepoThePendingPollJustRead_IsNotReadAgain(t *testing.T) {
	t.Parallel()
	source := &settledSource{
		rows:   []dashboard.PullRequest{settledRow(7, dashboard.CIFailure), settledRow(8, dashboard.CIPending)},
		latest: 2,
	}
	agg := settledAggregator(t, source)
	source.onRepo = func() { source.rows[0].LatestStatusID = 2 }

	agg.PollCI(t.Context())

	_, repoReads := source.counts()
	assert.Equal(t, 1, repoReads)
}
