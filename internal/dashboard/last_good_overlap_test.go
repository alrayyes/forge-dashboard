package dashboard_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// pausingSource is a twoReposSource that can hold a failed full refresh in the
// step after its fetch has returned, where the refresh computes its snapshot
// from copies it took earlier. A scoped refresh run while it holds lands in
// the window #4108 describes.
type pausingSource struct {
	twoReposSource
	pauseMu sync.Mutex
	entered chan struct{}
	release chan struct{}
}

// pauseNext makes the next failed full refresh stop and wait, and returns the
// channel that says it has stopped and the one that lets it go on.
func (s *pausingSource) pauseNext() (<-chan struct{}, func()) {
	s.pauseMu.Lock()
	defer s.pauseMu.Unlock()
	entered, released := make(chan struct{}), make(chan struct{})
	s.entered, s.release = entered, released

	return entered, func() { close(released) }
}

func (s *pausingSource) ProviderStatus(context.Context) *dashboard.ProviderStatus {
	s.pauseMu.Lock()
	entered, release := s.entered, s.release
	s.entered, s.release = nil, nil
	s.pauseMu.Unlock()
	if entered != nil {
		close(entered)
		<-release
	}

	return nil
}

// refreshWhileFullRefreshComputes fails a full refresh, then runs a second
// one that fails too and holds it mid-compute while webhooks refresh both repos.
// It returns the time the second one's failure was dated from, once it has
// settled.
func refreshWhileFullRefreshComputes(t *testing.T, agg *dashboard.Aggregator, src *pausingSource) (fullReadAt time.Time) {
	t.Helper()
	agg.Refresh(t.Context())
	src.goDown()
	agg.Refresh(t.Context())
	fullReadAt = *health(agg.Get(), dashboard.ForgeGitHub).StaleSince

	entered, release := src.pauseNext()
	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.Refresh(t.Context())
	}()
	<-entered
	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "a", "o/a"))
	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "b", "o/b"))
	require.True(t, health(agg.Get(), dashboard.ForgeGitHub).Reachable)
	release()
	<-done

	return fullReadAt
}

// A webhook that clears the forge's mark while a failing full refresh is still
// computing is not undone when that refresh settles (#4108).
func TestAggregator_AFullRefreshSettlingAfterWebhooksClearedTheForge_KeepsItReachable(t *testing.T) {
	t.Parallel()
	src := &pausingSource{forge: dashboard.ForgeGitHub}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	refreshWhileFullRefreshComputes(t, agg, src)

	h := health(agg.Get(), dashboard.ForgeGitHub)
	assert.True(t, h.Reachable)
	assert.Nil(t, h.StaleSince)
	assert.Empty(t, h.Error)
	assert.Nil(t, repoNamed(t, agg, "o/a").StaleSince)
	assert.Nil(t, repoNamed(t, agg, "o/b").StaleSince)
}

// The webhooks' read time outlives the full refresh that settled after them, so
// the next failure dates the rows from the webhooks, not the older full read.
func TestAggregator_AFullRefreshSettlingAfterWebhooksClearedTheForge_KeepsTheLaterGoodTime(t *testing.T) {
	t.Parallel()
	src := &pausingSource{forge: dashboard.ForgeGitHub}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	fullReadAt := refreshWhileFullRefreshComputes(t, agg, src)

	agg.Refresh(t.Context())

	for _, name := range []string{"o/a", "o/b"} {
		since := repoNamed(t, agg, name).StaleSince
		require.NotNil(t, since, name)
		assert.True(t, since.After(fullReadAt), "%s is dated from the webhook, not the last full read", name)
	}
}
