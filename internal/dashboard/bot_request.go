package dashboard

import (
	"slices"
	"strings"
	"time"
)

// BotName names the dependency bot a request went to.
type BotName string

// The bots this app can ask to rebase a pull request.
const (
	BotDependabot BotName = "dependabot"
	BotRenovate   BotName = "renovate"
)

// BotAction is what was asked of the bot. Renovate's rebase label is a
// BotRebase.
type BotAction string

// The actions a bot request can carry.
const (
	BotRebase   BotAction = "rebase"
	BotRecreate BotAction = "recreate"
)

// BotPhase is where a bot request stands.
type BotPhase string

// The phases of a bot request. Queued means asked and nothing seen yet,
// rebasing means the bot pushed and CI hasn't restarted, expired means the
// bot didn't act in time.
const (
	BotQueued   BotPhase = "queued"
	BotRebasing BotPhase = "rebasing"
	BotExpired  BotPhase = "expired"
)

const (
	// botQueuedWait is how long a request may stay queued without a
	// snapshot showing the bot acted. A bot that ignores the request would
	// otherwise leave the row waiting for good.
	botQueuedWait = 5 * time.Minute
	// botRebasingWait is how long "rebasing" waits for CI to show as
	// restarted, for a repo whose CI never will.
	botRebasingWait = 2 * time.Minute
	// botExpiredKeep is how long an expired request stays on the pull
	// request, so a client that wasn't looking can still say it expired.
	botExpiredKeep = time.Hour
)

// BotRequest is a Dependabot or Renovate rebase asked for through this app
// and not settled yet (#808). The server owns it, so a reload shows it again
// and every client agrees. It matches components.schemas.BotRequest.
type BotRequest struct {
	Bot         BotName   `json:"bot"`
	Action      BotAction `json:"action"`
	Phase       BotPhase  `json:"phase"`
	RequestedAt time.Time `json:"requestedAt"`
	// ExpiresAt is when the server stops waiting in the current phase.
	ExpiresAt time.Time `json:"expiresAt"`
}

// botEntry is a BotRequest plus what the server needs to tell it landed.
type botEntry struct {
	BotRequest

	wasBehind bool
	head      string
	// seq is the newest fetch that had started when the request was made.
	// Only a later fetch can show what the request did (#691).
	seq uint64
}

// RecordBotRequest notes that a bot was asked to rebase forge/repo#number. The
// pull request carries the request from now on, subscribers are told, and
// later snapshots move it along. A pull request not on the board is ignored,
// and a second request replaces the first.
func (a *Aggregator) RecordBotRequest(forge Forge, repo string, number int, bot BotName, action BotAction) {
	key := settledKey(forge, repo, number)

	a.mu.Lock()
	idx := slices.IndexFunc(a.snap.PullRequests, func(pr PullRequest) bool {
		return settledKey(pr.Forge, pr.Repo, pr.Number) == key
	})
	if idx < 0 {
		a.mu.Unlock()

		return
	}
	pr := a.snap.PullRequests[idx]
	now := a.now()

	a.botMu.Lock()
	a.botRequests[key] = &botEntry{
		Bot: bot, Action: action, Phase: BotQueued,
		RequestedAt: now, ExpiresAt: now.Add(botQueuedWait),
		wasBehind: pr.Behind,
		head:      pr.HeadSHA,
		seq:       a.fetchSeq.Load(),
	}
	a.botMu.Unlock()

	next := a.snap
	next.PullRequests = slices.Clone(a.snap.PullRequests)
	a.annotateBotRequests(next.PullRequests)
	a.snap = next
	a.mu.Unlock()

	a.notify(next)
}

// applyBotRequests moves every request that prs covers along and then marks
// each pull request with its request. seq is the fetch prs came from. covers
// says which forge and repo that fetch actually answered for: a pull request
// missing from a fetch of another repo, or from a forge that failed, says
// nothing about its request.
func (a *Aggregator) applyBotRequests(prs []PullRequest, seq uint64, covers func(Forge, string) bool) {
	a.botMu.Lock()
	if len(a.botRequests) > 0 {
		now := a.now()
		listed := make(map[string]PullRequest, len(prs))
		for _, pr := range prs {
			listed[settledKey(pr.Forge, pr.Repo, pr.Number)] = pr
		}
		for key, e := range a.botRequests {
			pr, present := listed[key]
			if !present {
				if botGone(key, covers) {
					delete(a.botRequests, key)
				}

				continue
			}
			if keep := e.advance(pr, seq, now); !keep {
				delete(a.botRequests, key)
			}
		}
	}
	a.botMu.Unlock()

	a.annotateBotRequests(prs)
}

// botGone reports whether a pull request missing from a fetch is really
// gone: only when that fetch covered its forge and repo.
func botGone(key string, covers func(Forge, string) bool) bool {
	forge, repo := splitSettledKey(key)

	return covers(forge, repo)
}

// advance applies one snapshot to the request and reports whether to keep it.
func (e *botEntry) advance(pr PullRequest, seq uint64, now time.Time) bool {
	switch e.Phase {
	case BotQueued:
		landed := seq > e.seq && ((e.head != "" && pr.HeadSHA != e.head) || (e.wasBehind && !pr.Behind))
		switch {
		case landed && pr.CI == CIPending:
			// The bot pushed and CI has restarted already: finished.
			return false
		case landed:
			e.Phase, e.ExpiresAt = BotRebasing, now.Add(botRebasingWait)
		case !now.Before(e.ExpiresAt):
			e.Phase = BotExpired
		}
	case BotRebasing:
		if pr.CI == CIPending || !now.Before(e.ExpiresAt) {
			return false
		}
	case BotExpired:
		if now.After(e.ExpiresAt.Add(botExpiredKeep)) {
			return false
		}
	}

	return true
}

// annotateBotRequests sets each pull request's BotRequest from the registry,
// and clears it where there is none.
func (a *Aggregator) annotateBotRequests(prs []PullRequest) {
	a.botMu.Lock()
	defer a.botMu.Unlock()

	for i := range prs {
		if e, ok := a.botRequests[settledKey(prs[i].Forge, prs[i].Repo, prs[i].Number)]; ok {
			req := e.BotRequest
			prs[i].BotRequest = &req
		} else {
			prs[i].BotRequest = nil
		}
	}
}

// splitSettledKey undoes settledKey: the forge before the first slash, the
// repo up to the last hash.
func splitSettledKey(key string) (Forge, string) {
	forge, rest, _ := strings.Cut(key, "/")
	repo := rest[:strings.LastIndex(rest, "#")]

	return Forge(forge), repo
}
