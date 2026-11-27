package dashboard

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
)

// settledRows is the pull requests whose CI ended without passing, on a forge
// whose check events don't all arrive by webhook. Rerunning their jobs on the
// same commit changes the row, and nothing announces it.
func settledRows(snap Snapshot) []PullRequest {
	return slices.DeleteFunc(slices.Clone(snap.PullRequests), func(pr PullRequest) bool {
		failed := pr.CI == CIFailure || pr.CI == CICancelled

		return !failed || !pr.Forge.Valid() || checksViaWebhook(pr.Forge) || pr.HeadSHA == "" || pr.LatestStatusID == 0
	})
}

func settledPollKey(pr PullRequest) string {
	return "settled/" + pullRequestKey(pr.Forge, pr.Repo, pr.Number)
}

// probeSettled asks each due settled row's forge for the newest status id of
// its head commit, and refreshes the repos where there is a newer one than the
// row was read with. It does nothing while nobody is using the dashboard.
func (a *Aggregator) probeSettled(ctx context.Context, snap Snapshot, rows []PullRequest, now time.Time, base time.Duration) {
	if a.activity.Idle() {
		return
	}

	moved := make(map[Forge][]pendingItem)
	keys := make(map[string]string)
	for _, pr := range rows {
		it, changed := a.probeRow(ctx, snap, pr, now, base)
		if !changed {
			continue
		}
		moved[pr.Forge] = append(moved[pr.Forge], it)
		keys[it.key()] = settledPollKey(pr)
	}

	for forge, items := range moved {
		for _, read := range a.refreshEachRepo(apistats.WithKind(ctx, apistats.KindCIPoll), forge, items) {
			a.pendingSched.polledUpTo(keys[read.item.key()], now, base, settledProbeCap, true)
		}
	}
}

// probeRow probes one settled row if it is due, and reports whether its commit
// has a newer status, with what to refresh. A row that has none, or can't be
// read, waits longer before the next probe.
func (a *Aggregator) probeRow(ctx context.Context, snap Snapshot, pr PullRequest, now time.Time, base time.Duration) (pendingItem, bool) {
	key := settledPollKey(pr)
	prober := a.settledProberFor(pr.Forge)
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if prober == nil || !ok || !a.pendingSched.due(key, now, base) {
		return pendingItem{}, false
	}
	if _, spent := exhaustedHealth(snap, pr.Forge, now); spent || a.budgetHold(snap, pr.Forge, apistats.KindCIPoll) {
		return pendingItem{}, false
	}
	ctx = scopedRefreshContext(apistats.WithKind(ctx, apistats.KindCIPoll), pr.Repo)
	latest, err := prober.LatestStatusID(ctx, owner, name, pr.HeadSHA)
	if err != nil {
		slog.Warn("failed pull request status read failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)
	}
	if err != nil || latest <= pr.LatestStatusID {
		a.pendingSched.polledUpTo(key, now, base, settledProbeCap, false)

		return pendingItem{}, false
	}

	return pendingItem{
		ref:         PullRequestRef{Forge: pr.Forge, Owner: owner, Name: name, FullName: pr.Repo, Number: pr.Number},
		kind:        apistats.KindCIPoll,
		fingerprint: pollFingerprint(pr),
	}, true
}

// settledProberFor is the Source that drives forge when it can probe a
// commit's statuses, or nil.
func (a *Aggregator) settledProberFor(forge Forge) SettledCheckProber {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		p, _ := src.(SettledCheckProber)

		return p
	}

	return nil
}
