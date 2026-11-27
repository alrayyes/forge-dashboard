package dashboard

import (
	"context"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A person's refresh stops waiting at the user deadline, but the forge keeps
// the scheduled deadline to answer in. A read its pass left behind runs on, and
// its outcome is put on the board when it comes (#5059).

// flight is one source's fetch, which can outlive the pass that started it.
type flight struct {
	i   int
	seq uint64
	// cancel ends this fetch alone.
	cancel context.CancelFunc

	mu    sync.Mutex
	state flightState
	// stops releases the timer and hook that can end a read left behind.
	stops []func() bool
	// behind is set from when the pass leaves the read until the board holds
	// its outcome, or it is dropped.
	behind atomic.Bool
}

type flightState int

const (
	flightWaited flightState = iota // its pass is waiting for the answer
	flightLeft                      // its pass moved on, the read goes on
	flightOver                      // answered or given up on
)

func (f *flight) in(state flightState) bool {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.state == state
}

// stopWaiting ends the pass's wait. early leaves the read running.
func (f *flight) stopWaiting(early bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != flightWaited {
		return
	}
	f.state = flightOver
	if early {
		f.state = flightLeft
		f.behind.Store(true)
	}
}

// deliver hands res to the pass if it still waits, and says what state the read
// was in. answers has room for one answer per source, so it never blocks.
func (f *flight) deliver(answers chan<- sourceAnswer, res Result) flightState {
	f.mu.Lock()
	defer f.mu.Unlock()
	was := f.state
	if was == flightWaited {
		answers <- sourceAnswer{f.i, res}
	}
	f.state = flightOver
	for _, stop := range f.stops {
		stop()
	}

	return was
}

// release frees a finished fetch's context. A read left behind keeps it.
func (f *flight) release() {
	if !f.in(flightLeft) {
		f.cancel()
	}
}

// leave gives a read its pass stopped waiting for the rest of the scheduled
// deadline, counted from when the pass began. It also ends with the
// Aggregator's run.
func (a *Aggregator) leave(ctx context.Context, f *flight, started time.Time) {
	stops := []func() bool{a.fetchAfter(max(a.fetchDeadline-a.now().Sub(started), 0), func() { a.expire(ctx, f) })}
	if a.debounceOwner != nil {
		stops = append(stops, context.AfterFunc(a.debounceOwner, f.cancel))
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != flightLeft {
		for _, stop := range stops {
			stop()
		}

		return
	}
	f.stops = stops
}

// expire gives up on a read still silent at the scheduled deadline. It counts
// as a missed pass.
func (a *Aggregator) expire(ctx context.Context, f *flight) {
	f.mu.Lock()
	if f.state != flightLeft {
		f.mu.Unlock()

		return
	}
	f.state = flightOver
	f.mu.Unlock()
	f.cancel()

	slog.Warn("fetch deadline passed with the forge still fetching", "forge", a.sources[f.i].Forge(), "path", "deadline", "running_for", a.fetchAge(f.i), "deadline", a.fetchDeadline)
	health := a.unreachableFrom(a.Get(), f.i)
	a.applyLate(ctx, f, sourceResult{Health: health, asked: true, missed: true})
}

// applyLate publishes the outcome of a read its pass left behind, with the
// writes that follow any refresh.
func (a *Aggregator) applyLate(ctx context.Context, f *flight, sr sourceResult) {
	previous, snap, ok := a.foldLate(ctx, f, sr)
	if !ok {
		return
	}
	a.noteSpendOf(f.i, sr.Result)
	logRateLimitTransitions(previous.Forges, snap.Forges)
	a.publish(ctx, snap)
	a.runWrites(ctx, snap)
	a.startWebhookUpgrade(snap)
}

// foldLate is refreshOnce for one forge: it replaces that forge's part of the
// snapshot and leaves the rest as it is. It drops the outcome of a run that has
// ended, and of a read a newer full refresh has overtaken.
func (a *Aggregator) foldLate(ctx context.Context, f *flight, sr sourceResult) (previous, snap Snapshot, ok bool) {
	// It asks the forge, so it stays outside foldMu: a hang holds up no one else.
	a.checkDependabotAcks(ctx)

	a.foldMu.Lock()
	defer a.foldMu.Unlock()
	defer f.behind.Store(false)

	src := a.sources[f.i]
	forge := src.Forge()

	a.mu.RLock()
	earlier := a.snap
	goodAt := maps.Clone(a.lastGood)
	streaks := cloneStreaks(a.failStreak)
	overtaken := a.fullSeq[forge] > f.seq
	a.mu.RUnlock()
	if overtaken || ctx.Err() != nil || (a.debounceOwner != nil && a.debounceOwner.Err() != nil) {
		return Snapshot{}, Snapshot{}, false
	}

	now := time.Now().UTC()
	readForges := make(map[Forge]bool)
	unread := make(map[repoKey]bool)
	read := rowsRead([]sourceResult{sr})
	logFailedRefresh(sr, forge)
	r := settleOrHold(sr.Result, sr.asked, sr.missed, earlier, goodAt, streaks, now, readForges, unread, forge)
	noteBlockedActions(&r.Health, src)
	noteProviderStatus(ctx, &r.Health, src)
	covers := func(other Forge, _ string) bool { return other == forge && r.Health.Reachable }

	a.mu.Lock()
	defer a.mu.Unlock()
	previous = a.snap
	// Under mu, so a MarkSettled is either seen here or runs on the new board.
	r.PullRequests = a.withoutSettled(r.PullRequests, forge, "")
	snap = replaceForge(previous, forge, r)
	snap.GeneratedAt = now
	a.applyBotRequests(snap.PullRequests, f.seq, covers)
	snap = a.keepNewerScopedRepos(snap, previous, f.seq)
	AnnotateStacks(snap.PullRequests)
	sortByRecency(snap.PullRequests, snap.Issues)
	a.annotateUnderLock(snap.PullRequests, f.seq, covers, read)
	a.snap = snap
	a.noteFullRead(f.seq, readForges, unread)
	a.keepLaterGood(goodAt)
	a.failStreak = streaks

	return previous, snap, true
}

// replaceForge is snap with forge's health and rows replaced by r's, in new slices.
func replaceForge(snap Snapshot, forge Forge, r Result) Snapshot {
	rest := rowsWhere(snap, func(other Forge) bool { return other != forge })
	rest.PullRequests = append(rest.PullRequests, r.PullRequests...)
	rest.Issues = append(rest.Issues, r.Issues...)
	rest.Repos = append(rest.Repos, r.Repos...)
	rest.MainBranches = append(rest.MainBranches, r.MainBranches...)
	snap.PullRequests, snap.Issues, snap.Repos, snap.MainBranches = rest.PullRequests, rest.Issues, rest.Repos, rest.MainBranches
	snap.Forges = slices.Clone(snap.Forges)
	if i := slices.IndexFunc(snap.Forges, func(h ForgeHealth) bool { return h.Forge == forge }); i >= 0 {
		snap.Forges[i] = r.Health
	} else {
		snap.Forges = append(snap.Forges, r.Health)
	}

	return snap
}

// rowsWhere is a copy of the rows in snap whose forge keep accepts.
func rowsWhere(snap Snapshot, keep func(Forge) bool) Result {
	return Result{
		PullRequests: slices.DeleteFunc(slices.Clone(snap.PullRequests), func(pr PullRequest) bool { return !keep(pr.Forge) }),
		Issues:       slices.DeleteFunc(slices.Clone(snap.Issues), func(i Issue) bool { return !keep(i.Forge) }),
		Repos:        slices.DeleteFunc(slices.Clone(snap.Repos), func(r Repo) bool { return !keep(r.Forge) }),
		MainBranches: slices.DeleteFunc(slices.Clone(snap.MainBranches), func(b MainBranch) bool { return !keep(b.Forge) }),
	}
}

// heldWhileReading is forge's part of a refresh that did not ask it or stopped
// waiting for it, because a read left behind is still running: the rows it had,
// shown as slow, even if the forge was unreachable before this read began. It
// counts as no miss. behind is false when that read's outcome reached the board
// in the meantime, which then stands. A starting forge stays starting.
func heldWhileReading(behind bool, earlier Snapshot, goodAt map[Forge]time.Time, forge Forge) Result {
	held := rowsWhere(earlier, func(other Forge) bool { return other == forge })
	prev, ok := healthOf(earlier, forge)
	switch {
	case !ok:
		held.Health = ForgeHealth{Forge: forge, Reachable: true, Cause: ForgeCauseSlow}
	case !behind || prev.Starting:
		held.Health = prev
	default:
		held.Health = answering(notSlow(prev))
		held.Health.Cause = ForgeCauseSlow
		if at, good := goodAt[forge]; good {
			held.Health.RowsReadAt = &at
		}
	}

	return held
}

// answering is h without what an earlier failure put on it, for a forge that
// has not failed the read it is on.
func answering(h ForgeHealth) ForgeHealth {
	h.Reachable = true
	h.Error, h.ErrorKind, h.UpstreamStatus = "", "", 0
	h.StaleSince, h.ProviderStatus = nil, nil

	return h
}

// readingBehind reports whether the pull request key belongs to a forge with a
// read left behind. That read may have started before a merge, so nothing seen
// meanwhile says the forge has stopped listing it.
func (a *Aggregator) readingBehind(key string) bool {
	for i := range a.flights {
		if f := a.flights[i].Load(); f != nil && f.behind.Load() && strings.HasPrefix(key, string(a.sources[i].Forge())+"/") {
			return true
		}
	}

	return false
}
