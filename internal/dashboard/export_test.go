package dashboard

import (
	"context"
	"runtime"
	"time"
)

// BackgroundForTest marks ctx the way the schedule does, so a test can run a
// refresh nobody asked for.
func BackgroundForTest(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}

// BoxOverrideCount is how many Renovate rebase box overrides the aggregator
// still holds.
func (a *Aggregator) BoxOverrideCount() int {
	a.botMu.Lock()
	defer a.botMu.Unlock()

	return len(a.boxOverrides)
}

// UserRefreshesForTest is how many refreshes a person is waiting on right now.
func (s *Service) UserRefreshesForTest() int {
	agg := s.aggregator()
	if agg == nil {
		return 0
	}

	return int(agg.userRefreshes.Load())
}

// ParkedRefreshesForTest is how many refresh calls are queued behind the
// in-flight one.
func (s *Service) ParkedRefreshesForTest() int {
	agg := s.aggregator()
	if agg == nil {
		return 0
	}

	return agg.refresh.waiting()
}

// RepoRefreshWaitingForTest is how many one-repo refreshes are queued behind
// the one running for forge/fullName.
func (a *Aggregator) RepoRefreshWaitingForTest(forge Forge, fullName string) int {
	a.repoRefresh.mu.Lock()
	c := a.repoRefresh.byKey[string(forge)+"/"+fullName]
	a.repoRefresh.mu.Unlock()
	if c == nil {
		return 0
	}

	return c.waiting()
}

// EndSentenceForTest exposes endSentence.
func EndSentenceForTest(msg string) string { return endSentence(msg) }

// MergeRetryAfterFailureForTest runs one failed merge through the attempt
// bookkeeping and reports whether the pull request is barred for ever and,
// if not, how long until it may be tried again.
func MergeRetryAfterFailureForTest(err error) (forever bool, wait time.Duration) {
	cfg := &autoMergeConfig{attempts: map[string]autoMergeAttempt{}, failures: map[string]AutoMergeFailure{}}
	pr := PullRequest{Forge: ForgeGitHub, Repo: "o/r", Number: 1, UpdatedAt: time.Now()}
	cfg.begin(pr)
	cfg.failed(pr, err)
	attempt := cfg.attempts[dependabotPRKey(pr)]

	return attempt.forever, time.Until(attempt.until)
}

// DebounceRememberedForTest is how many repos the webhook debouncer still
// remembers a recent run of.
func (a *Aggregator) DebounceRememberedForTest() int {
	a.debounce.mu.Lock()
	defer a.debounce.mu.Unlock()

	return len(a.debounce.lastFired)
}

// MergeRefusalForTest exposes mergeRefusal to the external tests.
func MergeRefusalForTest(err error) ActionRefusal { return mergeRefusal(err) }

// PollFingerprintForTest is what a CI poll can change about pr.
func PollFingerprintForTest(pr PullRequest) string { return pollFingerprint(pr) }

// CatchUpForTest runs the refresh Run does when someone opens the board after
// an idle spell.
func (a *Aggregator) CatchUpForTest(ctx context.Context) { a.catchUpPass(ctx) }

// WaitSourcesIdleForTest waits until no source's fetch is running.
func (a *Aggregator) WaitSourcesIdleForTest() {
	for i := range a.fetching {
		for a.fetching[i].Load() {
			runtime.Gosched()
		}
	}
}

// ParkedRefreshesForTest is how many refresh calls are queued behind the
// in-flight one.
func (a *Aggregator) ParkedRefreshesForTest() int { return a.refresh.waiting() }
