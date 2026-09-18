package github

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// issueState is the per-repo open-issue data a since-filtered poll
// reconciles against — see mergeIssueDelta's own doc comment for why
// this alone isn't enough to trust a delta blindly. Held on Client
// rather than passed in from the caller: it has to survive across
// separate Fetch calls, the same reason lastRESTRate does.
type issueState struct {
	mu sync.Mutex

	// lastPollTime is nil until the first successful Fetch — no prior
	// poll means nothing to filter *since*, so the very first request
	// has to ask for every open issue unconditionally rather than send
	// some zero-value time that would filter almost everything out.
	lastPollTime *time.Time
	// issuesByRepo holds the last known full open-issue set per repo
	// (keyed by fullName), rebuilt from scratch on every successful
	// Fetch so a repo this client stops tracking doesn't linger here
	// forever.
	issuesByRepo map[string][]dashboard.Issue
}

// since returns the value to send as the issues connection's own
// filterBy: {since: ...} argument — nil on the very first call.
func (s *issueState) since() *time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastPollTime
}

// previousIssues returns fullName's own last known open-issue set, and
// whether this client has ever actually seen that repo before — a repo
// with no prior state (never tracked, or new since the last poll) can
// never be safely merged, since there's nothing to merge the delta into
// (see mergeIssueDelta).
func (s *issueState) previousIssues(fullName string) ([]dashboard.Issue, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, ok := s.issuesByRepo[fullName]
	return prev, ok
}

// commit replaces the tracked state wholesale with pollStartedAt (the
// time captured right before this poll's own query ran — not after,
// so a change landing mid-poll still has an updatedAt at or after the
// next poll's own since and isn't silently missed) and issuesByRepo.
func (s *issueState) commit(pollStartedAt time.Time, issuesByRepo map[string][]dashboard.Issue) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastPollTime = &pollStartedAt
	s.issuesByRepo = issuesByRepo
}

// mergeIssueDelta combines prev (fullName's last known full open-issue
// set) with delta (whatever a since-filtered query reported changed)
// into what should now be the complete set, reporting false when the
// result can't be trusted.
//
// A since-filtered issues(states: OPEN) query only ever reports an issue
// that's still open and was created or updated since the given time —
// there is no tombstone for one that closed in between, it simply stops
// appearing. So the merge alone can never tell "nothing changed" apart
// from "something closed and the delta just doesn't mention it." What
// can tell them apart is totalCount, the repo's own true current open
// count reported alongside the delta in the same query: if the merged
// set's size matches it, nothing closed (or something closed and an
// equal number of new issues opened, indistinguishable from here, but
// that's the same heuristic gap totalCount reconciliation always has —
// good enough per #381's own design, not a bug this function is
// responsible for closing). A mismatch means the caller needs a real
// refetch instead of trusting this merge.
func mergeIssueDelta(prev, delta []dashboard.Issue, totalCount int) ([]dashboard.Issue, bool) {
	byNumber := make(map[int]dashboard.Issue, len(prev)+len(delta))
	for _, i := range prev {
		byNumber[i.Number] = i
	}
	for _, i := range delta {
		byNumber[i.Number] = i
	}
	if len(byNumber) != totalCount {
		return nil, false
	}
	merged := make([]dashboard.Issue, 0, len(byNumber))
	for _, i := range byNumber {
		merged = append(merged, i)
	}
	return merged, true
}

// reconcileIssues resolves every tracked repo's own final open-issue set
// for this poll: a repo whose delta merges cleanly against its previous
// state (or whose first-ever poll needed no merge at all — since is nil,
// so the "delta" is already the complete set) is used as-is; any other
// repo falls back to a real single-repo refetch via FetchRepo, the same
// scoped-fetch path a webhook delivery already uses (dashboard.
// RepoRefresher) — reused rather than duplicated, at the cost of that
// fallback call also re-fetching the repo's pull requests, which the
// batched query already has fresh regardless.
//
// Bounded concurrency, the same shape checkWebhooks already uses: a
// mismatch should be rare in ordinary use (most polls see no closures
// at all), so this only ever does real work for the repos that actually
// need it.
func (c *Client) reconcileIssues(ctx context.Context, tracked []graphqlRepo, sincePoll bool) map[string][]dashboard.Issue {
	result := make(map[string][]dashboard.Issue, len(tracked))
	var mu sync.Mutex
	sem := make(chan struct{}, dashboard.DefaultMaxConcurrency)
	var wg sync.WaitGroup

	for _, r := range tracked {
		fullName := r.Owner.Login + "/" + r.Name
		delta := make([]dashboard.Issue, 0, len(r.Issues.Nodes))
		for _, i := range r.Issues.Nodes {
			delta = append(delta, mapIssue(fullName, i))
		}

		if !sincePoll {
			// The very first poll (or any poll made with no since at
			// all) already asked for everything — the "delta" is the
			// full set, nothing to merge.
			result[fullName] = delta
			continue
		}

		prev, hadPrev := c.issueState.previousIssues(fullName)
		if hadPrev {
			if merged, ok := mergeIssueDelta(prev, delta, r.IssuesTotal.TotalCount); ok {
				result[fullName] = merged
				continue
			}
		}

		wg.Add(1)
		go func(r graphqlRepo, fullName string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			_, issues, err := c.FetchRepo(ctx, r.Owner.Login, r.Name, fullName)
			if err != nil {
				slog.Warn("issue reconciliation fallback refetch failed", "forge", dashboard.ForgeGitHub, "repo", fullName, "error", err)
				return
			}
			mu.Lock()
			result[fullName] = issues
			mu.Unlock()
		}(r, fullName)
	}
	wg.Wait()
	return result
}
