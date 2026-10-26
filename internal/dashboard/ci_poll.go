package dashboard

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
)

// pendingItem is one pull request a CI poll may ask about.
type pendingItem struct {
	ref  PullRequestRef
	kind apistats.Kind
	// ciPending is whether a check is still running, as opposed to the pull
	// request being polled only because its auto-merge is armed.
	ciPending bool
	// armed is whether GitHub is going to merge the pull request by itself.
	armed       bool
	headSHA     string
	fingerprint string
}

func (it pendingItem) key() string {
	return pullRequestKey(it.ref.Forge, it.ref.FullName, it.ref.Number)
}

// PollCI re-reads every open pull request whose CI is still pending, or that
// GitHub is going to merge by itself (auto-merge armed): the only cases a
// check finishing or a merge could change, and the only ones worth spending
// a request on between full Refresh passes. It fills the gap a working
// webhook would otherwise close. Real Forgejo instances silently drop the
// "status" event from a hook's persisted list (#177), so without it a finished
// check there waits out the whole Run interval.
//
// A source that implements PendingCheckRefresher answers all of a forge's
// pull requests in one request; any other is refreshed one repo at a time
// through RefreshRepo, the same keyed coalescer a webhook delivery uses.
//
// A pull request that reads the same after a poll waits longer before the next
// one, up to pendingPollCap, and a GitHub repo whose hook subscribes to check
// events and whose check deliveries are on time is not polled at all.
func (a *Aggregator) PollCI(ctx context.Context) {
	snap := a.Get()
	now := a.now()
	base := time.Duration(a.ciBase.Load())

	items := pendingItems(snap)
	live := make(map[string]struct{}, len(items))
	for _, it := range items {
		live[it.key()] = struct{}{}
	}
	a.pendingSched.keepOnly(live)

	byForge := make(map[Forge][]pendingItem)
	for _, it := range items {
		// A forge whose budget is spent can't answer until its reset: the next
		// full refresh already waits that out (NextRefreshDelay), so polling
		// meanwhile only repeats the refusal. An armed pull request can sit
		// for hours, so this is not a brief window.
		if _, spent := exhaustedHealth(snap, it.ref.Forge, now); spent {
			continue
		}
		if held := a.budgetHold(snap, it.ref.Forge, it.kind); held {
			continue
		}
		if a.waits(it, now, base) {
			continue
		}
		byForge[it.ref.Forge] = append(byForge[it.ref.Forge], it)
	}

	for forge, due := range byForge {
		// Only a pull request the poll actually read is scored. One it could not
		// read (an outage, a refused request) keeps its interval, so a forge
		// being down does not back every pending pull request off.
		for _, read := range a.pollForge(ctx, forge, due) {
			if !read.item.armed {
				a.pendingSched.polled(read.item.key(), now, base, read.changed)
			}
		}
	}
}

// waits reports whether it is not due this tick: backed off, or left to its
// webhook. GitHub merges an armed pull request without the dashboard, so the
// board only learns of it by reading; it is read every tick, never backed off and
// never left to the webhook.
func (a *Aggregator) waits(it pendingItem, now time.Time, base time.Duration) bool {
	if it.armed {
		return false
	}

	return !a.pendingSched.due(it.key(), now, base) || a.checksArriveByWebhook(it, now, base)
}

// polledPR is how a poll came out for one pull request it read.
type polledPR struct {
	item pendingItem
	// changed is whether what the poll read differs from what it started from.
	changed bool
}

// pendingItems lists the pull requests a poll is for.
func pendingItems(snap Snapshot) []pendingItem {
	var items []pendingItem
	for _, pr := range snap.PullRequests {
		if pr.CI != CIPending && !armedOnGitHub(pr) {
			continue
		}
		owner, name, ok := strings.Cut(pr.Repo, "/")
		if !ok {
			continue
		}
		kind := apistats.KindAutoMergePoll
		if pr.CI == CIPending {
			kind = apistats.KindCIPoll
		}
		items = append(items, pendingItem{
			ref:         PullRequestRef{Forge: pr.Forge, Owner: owner, Name: name, FullName: pr.Repo, Number: pr.Number},
			kind:        kind,
			ciPending:   pr.CI == CIPending,
			armed:       armedOnGitHub(pr),
			headSHA:     pr.HeadSHA,
			fingerprint: pollFingerprint(pr),
		})
	}

	return items
}

// pollForge refreshes the due pull requests of one forge and returns how it came
// out for each one it read. A pull request it could not read is left out.
func (a *Aggregator) pollForge(ctx context.Context, forge Forge, due []pendingItem) []polledPR {
	if batch := a.pendingRefresherFor(forge); batch != nil {
		// One request serves both reasons for polling, so it is counted as a CI
		// poll whenever a check is pending and as an auto-merge poll only if none is.
		kind := apistats.KindAutoMergePoll
		if slices.ContainsFunc(due, func(it pendingItem) bool { return it.kind == apistats.KindCIPoll }) {
			kind = apistats.KindCIPoll
		}

		return a.pollBatched(apistats.WithKind(ctx, kind), forge, batch, due)
	}

	return a.refreshEachRepo(ctx, forge, due)
}

// pollBatched asks the source about every due pull request at once and merges
// the answer. A ref the source could not answer is refreshed on its own repo.
// So is every ref a failed request left unanswered, all of them when the whole
// request failed and the later ones when only a later chunk did: the answers
// that did arrive are kept and merged, and a failure never costs the next tick
// the same batched request again.
func (a *Aggregator) pollBatched(ctx context.Context, forge Forge, src PendingCheckRefresher, due []pendingItem) []polledPR {
	refs := make([]PullRequestRef, len(due))
	byKey := make(map[string]pendingItem, len(due))
	for i, it := range due {
		refs[i] = it.ref
		byKey[it.key()] = it
	}

	seq := a.fetchSeq.Add(1)
	res, err := src.RefreshPending(ctx, refs)
	if err != nil {
		slog.Warn("pending check refresh failed", "forge", forge, "pull_requests", len(refs), "error", err)
	}
	a.mergePendingResult(ctx, forge, seq, res)

	read, failed := judgePending(forge, byKey, res)
	if err != nil {
		failed = append(failed, unanswered(due, read, failed)...)
	}

	return append(read, a.refreshEachRepo(ctx, forge, failed)...)
}

// judgePending sorts a PendingResult by the pull requests it was asked about:
// those it read, and those it could not answer.
//
// What the poll read is judged by its own answer, not by the snapshot after it:
// a webhook refresh landing meanwhile changes the snapshot, not what this poll
// found.
func judgePending(forge Forge, byKey map[string]pendingItem, res PendingResult) (read []polledPR, failed []pendingItem) {
	for _, pr := range res.Pulls {
		if it, ok := byKey[pullRequestKey(forge, pr.Repo, pr.Number)]; ok {
			read = append(read, polledPR{item: it, changed: pollFingerprint(pr) != it.fingerprint})
		}
	}
	for _, ref := range res.Closed {
		if it, ok := byKey[pullRequestKey(forge, ref.FullName, ref.Number)]; ok {
			read = append(read, polledPR{item: it, changed: true})
		}
	}
	for _, ref := range res.Failed {
		if it, ok := byKey[pullRequestKey(forge, ref.FullName, ref.Number)]; ok {
			failed = append(failed, it)
		}
	}

	return read, failed
}

// unanswered is the due items that are in neither read nor failed: what a
// request that failed part way never got to.
func unanswered(due []pendingItem, read []polledPR, failed []pendingItem) []pendingItem {
	answered := make(map[string]struct{}, len(read)+len(failed))
	for _, r := range read {
		answered[r.item.key()] = struct{}{}
	}
	for _, it := range failed {
		answered[it.key()] = struct{}{}
	}

	return slices.DeleteFunc(slices.Clone(due), func(it pendingItem) bool {
		_, done := answered[it.key()]

		return done
	})
}

// refreshEachRepo re-reads the repos of items, one scoped refresh per repo
// however many of its pull requests are due, through RefreshRepo, the same keyed
// coalescer a webhook delivery uses. A pull request counts as read only when its
// repo's refresh succeeded, and is judged by the snapshot that refresh left: it
// is still listed and unchanged, or it is not.
func (a *Aggregator) refreshEachRepo(ctx context.Context, forge Forge, items []pendingItem) []polledPR {
	var read []polledPR
	for _, group := range groupByRepo(items) {
		read = append(read, a.refreshRepoOf(ctx, forge, group)...)
	}

	return read
}

// groupByRepo splits items by repo, in the order the repos first appear.
func groupByRepo(items []pendingItem) [][]pendingItem {
	index := make(map[string]int)
	var groups [][]pendingItem
	for _, it := range items {
		i, seen := index[it.ref.FullName]
		if !seen {
			i = len(groups)
			index[it.ref.FullName] = i
			groups = append(groups, nil)
		}
		groups[i] = append(groups[i], it)
	}

	return groups
}

// refreshRepoOf refreshes the one repo group's pull requests belong to.
func (a *Aggregator) refreshRepoOf(ctx context.Context, forge Forge, group []pendingItem) []polledPR {
	first := group[0].ref
	if apistats.KindFrom(ctx) == apistats.KindUnknown {
		kind := apistats.KindAutoMergePoll
		if slices.ContainsFunc(group, func(it pendingItem) bool { return it.kind == apistats.KindCIPoll }) {
			kind = apistats.KindCIPoll
		}
		ctx = apistats.WithKind(ctx, kind)
	}
	// A call that joined a refresh already in flight ran no fetch of its own, but
	// the coalescer guarantees the run it waited for began after this call did, so
	// a merge newer than this sequence number is a read this poll can count.
	since := a.fetchSeq.Add(1)
	if !a.RefreshRepo(ctx, forge, first.Owner, first.Name, first.FullName) || !a.mergedSince(forge, first.FullName, since) {
		return nil
	}

	after := make(map[string]string)
	for _, pr := range a.Get().PullRequests {
		if pr.Forge == forge && pr.Repo == first.FullName {
			after[pullRequestKey(pr.Forge, pr.Repo, pr.Number)] = pollFingerprint(pr)
		}
	}
	read := make([]polledPR, 0, len(group))
	for _, it := range group {
		fingerprint, listed := after[it.key()]
		read = append(read, polledPR{item: it, changed: !listed || fingerprint != it.fingerprint})
	}

	return read
}

// mergePendingResult puts a PendingResult into the snapshot: each answered pull
// request replaces its old row and each closed one leaves, while the repo's
// other pull requests, its issues and its main branch stay as they were.
//
// The rows are built and written under one hold of the snapshot lock, and a repo
// that a newer scoped refresh has written since the poll began is left alone: a
// webhook's fetch is fresher than this poll's answer.
func (a *Aggregator) mergePendingResult(ctx context.Context, forge Forge, seq uint64, res PendingResult) {
	repos := make(map[string]struct{})
	replaced := make(map[string]PullRequest)
	closed := make(map[string]struct{})
	// Only these were read from the forge. The repo's other rows are the
	// snapshot's own, so they say nothing about a rebase box (settleBoxOverrides).
	read := make(map[string]bool)
	for _, pr := range res.Pulls {
		key := pullRequestKey(forge, pr.Repo, pr.Number)
		repos[pr.Repo], replaced[key], read[key] = struct{}{}, pr, true
	}
	for _, ref := range res.Closed {
		key := pullRequestKey(forge, ref.FullName, ref.Number)
		repos[ref.FullName], closed[key], read[key] = struct{}{}, struct{}{}, true
	}

	merges := make([]repoRows, 0, len(repos))
	for repo := range repos {
		merges = append(merges, repoRows{fullName: repo, read: onlyRead(read), rows: func(current Snapshot) ([]PullRequest, []Issue, bool) {
			if a.scopedSeq[repoKey{forge, repo}] > seq {
				return nil, nil, false
			}
			var issues []Issue
			for _, i := range current.Issues {
				if i.Forge == forge && i.Repo == repo {
					issues = append(issues, i)
				}
			}

			return repoPullRequestsAfter(current, forge, repo, replaced, closed), issues, true
		}})
	}
	a.mergeReposFrom(ctx, forge, seq, merges)
}

// repoPullRequestsAfter is the repo's pull requests in snap with the replaced
// ones swapped in and the closed ones dropped.
func repoPullRequestsAfter(snap Snapshot, forge Forge, repo string, replaced map[string]PullRequest, closed map[string]struct{}) []PullRequest {
	var prs []PullRequest
	for _, pr := range snap.PullRequests {
		if pr.Forge != forge || pr.Repo != repo {
			continue
		}
		key := pullRequestKey(forge, repo, pr.Number)
		if _, gone := closed[key]; gone {
			continue
		}
		if fresh, ok := replaced[key]; ok {
			pr = fresh
		}
		prs = append(prs, pr)
	}

	return prs
}

// pendingRefresherFor is the Source that drives forge when it can answer many
// pull requests at once, or nil.
func (a *Aggregator) pendingRefresherFor(forge Forge) PendingCheckRefresher {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if r, ok := src.(PendingCheckRefresher); ok {
			return r
		}

		return nil
	}

	return nil
}

// checkEventNames are the hook events a GitHub hook gets finished checks from.
var checkEventNames = []string{"check_run"}

// checksArriveByWebhook reports whether a poll of it can wait for the webhook:
// the pull request waits on a check, the forge is GitHub (Forgejo's hook drops
// the status event, #177), the app's hook on the repo is confirmed and
// subscribes to check events, and a check delivery for this pull request's own
// head commit arrived within the overdue period. Another pull request's
// deliveries, or an earlier commit's, say nothing about this one, so they do not
// count. A delivery only counts once its signature was verified and its body
// named the commit, and it can hold polling off for pendingPollCap at most.
func (a *Aggregator) checksArriveByWebhook(it pendingItem, now time.Time, base time.Duration) bool {
	if !it.ciPending || it.ref.Forge != ForgeGitHub || base <= 0 || it.headSHA == "" {
		return false
	}
	reporter := a.webhookEventsFor(it.ref.Forge)
	if reporter == nil {
		return false
	}
	events, confirmed := reporter.WebhookEvents(it.ref.FullName)
	if !confirmed || !slices.ContainsFunc(events, func(e string) bool { return slices.Contains(checkEventNames, e) }) {
		return false
	}
	last, seen := a.LastCheckDelivery(it.ref.Forge, it.ref.FullName, it.headSHA)
	if !seen || now.Sub(last) > overdueMultiple*base {
		return false
	}

	return a.pendingSched.holdOff(pullRequestKey(it.ref.Forge, it.ref.FullName, it.ref.Number), now, base)
}

func (a *Aggregator) webhookEventsFor(forge Forge) WebhookEventsReporter {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		r, _ := src.(WebhookEventsReporter)

		return r
	}

	return nil
}
