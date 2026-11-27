package dashboard_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// twenty points of a 5000 point budget are 144 seconds of the webhook share.
const paidFor = 144 * time.Second

// holdFirstFetch makes the first one-repo fetch from now on wait for the
// returned release, and says when it has begun.
func (f *costFixture) holdFirstFetch() (begun <-chan struct{}, release func()) {
	started, gate := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	f.src.onFetchRepo = func(string) {
		if held.CompareAndSwap(false, true) {
			close(started)
			<-gate
		}
	}

	return started, func() { close(gate) }
}

// untilJoined waits for a second caller to be queued behind the running fetch.
func (f *costFixture) untilJoined() {
	f.t.Helper()
	require.Eventually(f.t, func() bool { return f.agg.RepoRefreshWaitingForTest(dashboard.ForgeGitHub, "me/a") > 0 }, 5*time.Second, time.Millisecond)
}

func (f *costFixture) fetches() int { return f.src.repoFetchCallCount("me/a") }

func (f *costFixture) poll() {
	f.agg.RefreshRepo(apistats.WithKind(f.t.Context(), apistats.KindCIPoll), dashboard.ForgeGitHub, "me", "a", "me/a")
}

// A delivery that comes due while a refresh runs joins it, and the run that
// follows waits until the first one is paid for. Its own points count too.
func TestWebhookCost_ADeliveryDueDuringARefresh_WaitsForItToBePaidFor(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 20)
	begun, release := f.holdFirstFetch()
	f.event("a")
	f.clock.AdvanceWithoutWaiting(2 * time.Second)
	<-begun
	f.event("a")
	f.clock.AdvanceWithoutWaiting(40 * time.Second)
	f.untilJoined()
	release()
	f.clock.Wait()

	require.Equal(t, 1, f.fetches(), "the follow-up must not start on the heels of the first")
	f.clock.Advance(paidFor - 40*time.Second)
	require.Equal(t, 2, f.fetches(), "and is not lost")

	f.event("a")
	f.clock.Advance(paidFor - time.Second)
	require.Equal(t, 2, f.fetches(), "the second one is paid for as well")
	f.clock.Advance(time.Second)
	assert.Equal(t, 3, f.fetches())
}

func TestWebhookCost_ADeliveryJoiningAPollsFetch_IsPaced(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 20)
	begun, release := f.holdFirstFetch()
	polled := make(chan struct{})
	go func() {
		defer close(polled)
		f.poll()
	}()
	<-begun
	f.event("a")
	f.clock.AdvanceWithoutWaiting(2 * time.Second)
	f.untilJoined()
	release()
	f.clock.Wait()
	<-polled
	require.Equal(t, 2, f.fetches(), "the poll's, then the delivery's")

	f.event("a")
	f.clock.Advance(paidFor - time.Second)

	assert.Equal(t, 2, f.fetches(), "the delivery's own read has to be paid for")
}

func TestWebhookCost_APollJoiningAWebhooksFetch_IsNotCharged(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 20)
	begun, release := f.holdFirstFetch()
	f.event("a")
	f.clock.AdvanceWithoutWaiting(2 * time.Second)
	<-begun
	polled := make(chan struct{})
	go func() {
		defer close(polled)
		f.poll()
	}()
	f.untilJoined()
	// So a second charge would reach further than the first one.
	f.clock.AdvanceWithoutWaiting(60 * time.Second)
	release()
	f.clock.Wait()
	<-polled
	require.Equal(t, 2, f.fetches())

	f.event("a")
	f.clock.Advance(paidFor - 60*time.Second)

	assert.Equal(t, 3, f.fetches(), "only the delivery's read is owed")
}

func TestWebhookCost_APollsFetch_DoesNotHoldTheNextDelivery(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 20)
	f.poll()

	f.event("a")
	f.clock.Advance(2 * time.Second)

	assert.Equal(t, 2, f.fetches())
}

func TestWebhookCost_AFailedFetch_IsPaidFor(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 20)
	f.src.failRepoFetches(errors.New("boom"))
	f.event("a")
	f.clock.Advance(2 * time.Second)

	f.event("a")
	f.clock.Advance(paidFor - time.Second)
	require.Equal(t, 1, f.fetches())
	f.clock.Advance(time.Second)

	assert.Equal(t, 2, f.fetches())
}

// What the merge goes on to ask of the forge, about other repositories too, is
// not this repository's to pay for.
func TestWebhookCost_WhatFollowsTheRead_IsNotCharged(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 1)
	f.src.ackCost = 100
	f.agg.RecordBotRequest(dashboard.ForgeGitHub, "me/a", 1, dashboard.BotDependabot, dashboard.BotRebase)
	f.event("a")
	f.clock.Advance(2 * time.Second)
	require.Positive(t, f.src.acks.Load(), "the merge asked about the rebase request")

	f.event("a")
	f.clock.Advance(30 * time.Second)

	assert.Equal(t, 2, f.fetches())
}

func (s *costlySource) DependabotAck(ctx context.Context, _, _ string, _ int, _ string, _ time.Time) (dashboard.CommandAck, error) {
	s.acks.Add(1)
	s.stats.AddCost(ctx, string(dashboard.ForgeGitHub), "token", s.ackCost)

	return dashboard.CommandAck{}, nil
}
