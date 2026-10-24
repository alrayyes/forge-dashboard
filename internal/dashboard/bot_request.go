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
	// snapshot showing the bot acted, and how long Dependabot gets to push
	// once it has acknowledged. A bot that ignores the request would
	// otherwise leave the row waiting for good. Dependabot can sit on a
	// command for several minutes when it is busy, so this is generous.
	botQueuedWait = 10 * time.Minute
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
	// AcknowledgedAt is when this app first saw Dependabot's thumbs-up on the
	// command comment (#1082). Nil until then, and always nil for Renovate.
	AcknowledgedAt *time.Time `json:"acknowledgedAt,omitempty"`
	// CommentURL is the command comment on the forge, once this app has
	// found it.
	CommentURL string `json:"commentUrl,omitempty"`
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

// boxOverride is a rebase box state this app set itself, and the newest fetch
// that had started when it did. A fetch that began earlier may have read the
// description before the change, so it can't undo it.
type boxOverride struct {
	ticked bool
	seq    uint64
}

// amendPullRequest applies amend to a copy of forge/repo#number on the snapshot,
// re-annotates the bot requests and tells subscribers, in one update. A pull
// request not on the board is ignored. amend runs under the snapshot lock and
// may take botMu.
func (a *Aggregator) amendPullRequest(forge Forge, repo string, number int, amend func(pr *PullRequest, key string)) {
	key := settledKey(forge, repo, number)

	a.mu.Lock()
	idx := slices.IndexFunc(a.snap.PullRequests, func(pr PullRequest) bool {
		return settledKey(pr.Forge, pr.Repo, pr.Number) == key
	})
	if idx < 0 {
		a.mu.Unlock()

		return
	}

	next := a.snap
	next.PullRequests = slices.Clone(a.snap.PullRequests)
	amend(&next.PullRequests[idx], key)
	a.annotateBotRequests(next.PullRequests)
	a.snap = next
	a.mu.Unlock()

	a.notify(next)
}

// recordBotLocked registers a queued request for pr. The caller holds mu.
func (a *Aggregator) recordBotLocked(pr *PullRequest, key string, bot BotName, action BotAction) {
	now := a.now()

	a.botMu.Lock()
	defer a.botMu.Unlock()
	a.botRequests[key] = &botEntry{
		Bot: bot, Action: action, Phase: BotQueued,
		RequestedAt: now, ExpiresAt: now.Add(botQueuedWait),
		wasBehind: pr.Behind,
		head:      pr.HeadSHA,
		seq:       a.fetchSeq.Load(),
	}
}

// setBoxLocked notes the box state on pr. The caller holds mu.
func (a *Aggregator) setBoxLocked(pr *PullRequest, key string, ticked bool) {
	pr.RenovateRebaseRequested = ticked

	a.botMu.Lock()
	defer a.botMu.Unlock()
	a.boxOverrides[key] = boxOverride{ticked: ticked, seq: a.fetchSeq.Load()}
	if e, ok := a.botRequests[key]; ok && !ticked && e.Bot == BotRenovate {
		delete(a.botRequests, key)
	}
}

// RecordBotRequest notes that a bot was asked to rebase forge/repo#number. The
// pull request carries the request from now on, subscribers are told, and
// later snapshots move it along. A pull request not on the board is ignored,
// and a second request replaces the first.
func (a *Aggregator) RecordBotRequest(forge Forge, repo string, number int, bot BotName, action BotAction) {
	a.amendPullRequest(forge, repo, number, func(pr *PullRequest, key string) {
		a.recordBotLocked(pr, key, bot, action)
	})
}

// RecordRenovateRebase notes that Renovate was asked to rebase through its
// ticked box: the request and the box land in one snapshot, so the board never
// shows a pending request without the matching cancel.
func (a *Aggregator) RecordRenovateRebase(forge Forge, repo string, number int) {
	a.amendPullRequest(forge, repo, number, func(pr *PullRequest, key string) {
		a.recordBotLocked(pr, key, BotRenovate, BotRebase)
		a.setBoxLocked(pr, key, true)
	})
}

// SetRenovateRebaseBox notes on the snapshot that Renovate's rebase box on
// forge/repo#number was just ticked or cleared here, so the board offers the
// matching action before the next fetch reads the description again. Clearing it
// also drops a Renovate request still waiting on it. A fetch that started
// before this call can't undo it. A pull request the snapshot doesn't hold is
// left alone.
func (a *Aggregator) SetRenovateRebaseBox(forge Forge, repo string, number int, ticked bool) {
	a.amendPullRequest(forge, repo, number, func(pr *PullRequest, key string) {
		a.setBoxLocked(pr, key, ticked)
	})
}

// applyBoxOverrides puts the box state this app set back over any fetch that
// started before it, and forgets the override once a later fetch has read the
// description itself. covers is what applyBotRequests takes. The caller holds
// botMu.
func (a *Aggregator) applyBoxOverrides(prs []PullRequest, seq uint64, covers func(Forge, string) bool) {
	if len(a.boxOverrides) == 0 {
		return
	}
	listed := make(map[string]bool, len(prs))
	for i := range prs {
		key := settledKey(prs[i].Forge, prs[i].Repo, prs[i].Number)
		listed[key] = true
		o, ok := a.boxOverrides[key]
		if !ok || !covers(prs[i].Forge, prs[i].Repo) {
			continue
		}
		if seq <= o.seq {
			prs[i].RenovateRebaseRequested = o.ticked

			continue
		}
		delete(a.boxOverrides, key)
	}
	// A pull request that merged or closed first never gets a later fetch to
	// retire its override, so a fetch that covers it and doesn't list it does.
	for key := range a.boxOverrides {
		if !listed[key] && botGone(key, covers) {
			delete(a.boxOverrides, key)
		}
	}
}

// reannotateUnderLock is what a full refresh does just before it swaps its
// snapshot in: the requests and box states recorded since applyBotRequests ran.
func (a *Aggregator) reannotateUnderLock(prs []PullRequest, seq uint64) {
	a.annotateBotRequests(prs)
	a.reapplyBoxOverrides(prs, seq)
}

// reapplyBoxOverrides puts the box state this app set back over prs, a
// snapshot from the fetch numbered seq, when that fetch started before the
// change. A tick or cancel can land between applyBotRequests and the moment the
// snapshot is swapped in; the caller holds mu, which every change takes too, so
// this leaves no gap.
func (a *Aggregator) reapplyBoxOverrides(prs []PullRequest, seq uint64) {
	a.botMu.Lock()
	defer a.botMu.Unlock()

	for i := range prs {
		o, ok := a.boxOverrides[settledKey(prs[i].Forge, prs[i].Repo, prs[i].Number)]
		if ok && seq <= o.seq {
			prs[i].RenovateRebaseRequested = o.ticked
		}
	}
}

// applyBotRequests moves every request that prs covers along and then marks
// each pull request with its request. seq is the fetch prs came from. covers
// says which forge and repo that fetch actually answered for: a pull request
// missing from a fetch of another repo, or from a forge that failed, says
// nothing about its request.
func (a *Aggregator) applyBotRequests(prs []PullRequest, seq uint64, covers func(Forge, string) bool) {
	a.botMu.Lock()
	a.applyBoxOverrides(prs, seq, covers)
	a.advanceUpdateRequests(prs, seq, covers)
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
		prs[i].UpdateRequest = a.updateRequestOf(prs[i])
	}
}

// splitSettledKey undoes settledKey: the forge before the first slash, the
// repo up to the last hash.
func splitSettledKey(key string) (Forge, string) {
	forge, rest, _ := strings.Cut(key, "/")
	repo := rest[:strings.LastIndex(rest, "#")]

	return Forge(forge), repo
}
