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
	ciPending   bool
	headSHA     string
	fingerprint string
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
		live[pullRequestKey(it.ref.Forge, it.ref.FullName, it.ref.Number)] = struct{}{}
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
		if !a.pendingSched.due(pullRequestKey(it.ref.Forge, it.ref.FullName, it.ref.Number), now, base) {
			continue
		}
		if a.checksArriveByWebhook(it, now, base) {
			continue
		}
		byForge[it.ref.Forge] = append(byForge[it.ref.Forge], it)
	}

	for forge, due := range byForge {
		a.pollForge(ctx, forge, due)
		a.notePolled(due, now, base)
	}
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
			headSHA:     pr.HeadSHA,
			fingerprint: pollFingerprint(pr),
		})
	}

	return items
}

// pollForge refreshes the due pull requests of one forge.
func (a *Aggregator) pollForge(ctx context.Context, forge Forge, due []pendingItem) {
	// One request serves both reasons for polling, so it is counted as a CI
	// poll whenever a check is pending and as an auto-merge poll only if none is.
	kind := apistats.KindAutoMergePoll
	if slices.ContainsFunc(due, func(it pendingItem) bool { return it.kind == apistats.KindCIPoll }) {
		kind = apistats.KindCIPoll
	}

	if batch := a.pendingRefresherFor(forge); batch != nil {
		a.pollBatched(apistats.WithKind(ctx, kind), forge, batch, due)

		return
	}

	// One scoped refresh per repo, however many of its pull requests are due.
	repoKind := make(map[string]apistats.Kind)
	for _, it := range due {
		if repoKind[it.ref.FullName] != apistats.KindCIPoll {
			repoKind[it.ref.FullName] = it.kind
		}
	}
	for _, it := range due {
		repoKindOf, ok := repoKind[it.ref.FullName]
		if !ok {
			continue
		}
		delete(repoKind, it.ref.FullName)
		a.RefreshRepo(apistats.WithKind(ctx, repoKindOf), forge, it.ref.Owner, it.ref.Name, it.ref.FullName)
	}
}

// pollBatched asks the source about every due pull request at once and merges
// the answer. A ref the source could not answer is refreshed on its own repo;
// a failure of the whole request is logged and retried at the next tick.
func (a *Aggregator) pollBatched(ctx context.Context, forge Forge, src PendingCheckRefresher, due []pendingItem) {
	refs := make([]PullRequestRef, len(due))
	for i, it := range due {
		refs[i] = it.ref
	}

	seq := a.fetchSeq.Add(1)
	res, err := src.RefreshPending(ctx, refs)
	if err != nil {
		slog.Warn("pending check refresh failed", "forge", forge, "pull_requests", len(refs), "error", err)

		return
	}
	a.mergePendingResult(ctx, forge, seq, res)

	fallback := make(map[string]PullRequestRef)
	for _, ref := range res.Failed {
		fallback[ref.FullName] = ref
	}
	for repo, ref := range fallback {
		slog.Warn("pending check refresh fell back to the whole repo", "forge", forge, "repo", repo)
		a.RefreshRepo(ctx, forge, ref.Owner, ref.Name, repo)
	}
}

// mergePendingResult puts a PendingResult into the snapshot: each answered pull
// request replaces its old row and each closed one leaves, while the repo's
// other pull requests, its issues and its main branch stay as they were.
func (a *Aggregator) mergePendingResult(ctx context.Context, forge Forge, seq uint64, res PendingResult) {
	repos := make(map[string]struct{})
	replaced := make(map[string]PullRequest)
	closed := make(map[string]struct{})
	for _, pr := range res.Pulls {
		repos[pr.Repo] = struct{}{}
		replaced[pullRequestKey(forge, pr.Repo, pr.Number)] = pr
	}
	for _, ref := range res.Closed {
		repos[ref.FullName] = struct{}{}
		closed[pullRequestKey(forge, ref.FullName, ref.Number)] = struct{}{}
	}

	for repo := range repos {
		snap := a.Get()
		prs := repoPullRequestsAfter(snap, forge, repo, replaced, closed)
		var issues []Issue
		for _, i := range snap.Issues {
			if i.Forge == forge && i.Repo == repo {
				issues = append(issues, i)
			}
		}
		a.mergeRepo(ctx, forge, repo, seq, prs, issues, nil)
	}
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

// notePolled tells the schedule how each polled pull request came out, by
// comparing what the poll was started from with the snapshot now.
func (a *Aggregator) notePolled(polled []pendingItem, now time.Time, base time.Duration) {
	after := make(map[string]string)
	for _, pr := range a.Get().PullRequests {
		after[pullRequestKey(pr.Forge, pr.Repo, pr.Number)] = pollFingerprint(pr)
	}
	for _, it := range polled {
		key := pullRequestKey(it.ref.Forge, it.ref.FullName, it.ref.Number)
		a.pendingSched.polled(key, now, base, after[key] != it.fingerprint)
	}
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
var checkEventNames = []string{"check_run", "check_suite"}

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
