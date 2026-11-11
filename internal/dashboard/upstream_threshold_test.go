package dashboard_test

import (
	"context"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// answeringBadly serves one forge that can answer with a 5xx.
type answeringBadly struct {
	mu   sync.Mutex
	kind dashboard.ForgeErrorKind
}

func (s *answeringBadly) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *answeringBadly) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.kind != "" {
		return dashboard.Result{Health: dashboard.ForgeHealth{
			Forge: dashboard.ForgeGitHub, Error: "GitHub returned 504 Gateway Timeout",
			ErrorKind: s.kind, UpstreamStatus: 504,
		}}
	}

	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 1}},
		Repos:        []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "o/r"}},
	}
}

func (s *answeringBadly) set(kind dashboard.ForgeErrorKind) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kind = kind
}

// One 5xx among healthy fetches is not an outage (#3527).
func TestAggregator_UpstreamErrorsFlipTheForgeOnlyAfterSeveralInARow(t *testing.T) {
	t.Parallel()

	src := &answeringBadly{}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	src.set(dashboard.ForgeErrorUpstream)
	for range dashboard.ForgeFailureThreshold - 1 {
		agg.Refresh(t.Context())
		h := health(agg.Get(), dashboard.ForgeGitHub)
		assert.True(t, h.Reachable, "still counted as reachable")
		assert.Nil(t, h.StaleSince)
		assert.Equal(t, []int{1}, numbers(agg.Get()), "keeps showing its rows")
	}

	agg.Refresh(t.Context())
	h := health(agg.Get(), dashboard.ForgeGitHub)
	assert.False(t, h.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUpstream, h.ErrorKind)
	assert.Equal(t, 504, h.UpstreamStatus)
	require.NotNil(t, h.StaleSince)

	src.set("")
	agg.Refresh(t.Context())
	h = health(agg.Get(), dashboard.ForgeGitHub)
	assert.True(t, h.Reachable, "recovers on the first success")
	assert.Nil(t, h.StaleSince)
}

func TestAggregator_ASuccessResetsTheFailureCount(t *testing.T) {
	t.Parallel()

	src := &answeringBadly{}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	for range 3 {
		src.set(dashboard.ForgeErrorUpstream)
		for range dashboard.ForgeFailureThreshold - 1 {
			agg.Refresh(t.Context())
		}
		src.set("")
		agg.Refresh(t.Context())
	}

	assert.True(t, health(agg.Get(), dashboard.ForgeGitHub).Reachable)
}

func TestAggregator_UnreachableIsNotHeldBack(t *testing.T) {
	t.Parallel()

	src := &answeringBadly{}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	src.set(dashboard.ForgeErrorUnreachable)
	agg.Refresh(t.Context())

	assert.False(t, health(agg.Get(), dashboard.ForgeGitHub).Reachable, "no response at all shows at once")
}

func TestHumanizeForgeError_NamesAnUpstreamError(t *testing.T) {
	t.Parallel()

	assert.Contains(t, dashboard.HumanizeForgeError(dashboard.ForgeErrorUpstream), "answered")
}
