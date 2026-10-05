package dashboard

import (
	"slices"
	"time"
)

// UpdatePhase is where an Update branch request stands.
type UpdatePhase string

// The phases of an Update branch request. Queued means the forge accepted it
// and no snapshot shows the branch caught up yet, expired means it still
// hasn't after updateQueuedWait.
const (
	UpdateQueued  UpdatePhase = "queued"
	UpdateExpired UpdatePhase = "expired"
)

const (
	// updateQueuedWait is how long a request may stay queued. GitHub runs
	// the update as a background job and a forge can refuse it later, so a
	// request that never lands must not leave the row waiting for good.
	updateQueuedWait = 5 * time.Minute
	// updateExpiredKeep is how long an expired request stays on the pull
	// request, so a client that wasn't looking can still say it expired.
	updateExpiredKeep = time.Hour
)

// UpdateRequest is an Update branch the forge accepted and that no snapshot
// has shown landing yet (#982). The server owns it, so a reload shows it again
// and every client agrees. It matches components.schemas.UpdateRequest.
type UpdateRequest struct {
	Phase       UpdatePhase `json:"phase"`
	RequestedAt time.Time   `json:"requestedAt"`
	// ExpiresAt is when the server stops waiting in the current phase.
	ExpiresAt time.Time `json:"expiresAt"`
}

// updateEntry is an UpdateRequest plus what the server needs to tell it landed.
type updateEntry struct {
	UpdateRequest

	// seq is the newest fetch that had started when the request was made.
	// Only a later fetch can show what the request did (#691).
	seq uint64
}

// RecordUpdateRequest notes that the forge accepted an Update branch for
// forge/repo#number. The pull request carries the request from now on,
// subscribers are told, and later snapshots clear it once the branch is no
// longer behind. A pull request not on the board is ignored, and a second
// request replaces the first.
func (a *Aggregator) RecordUpdateRequest(forge Forge, repo string, number int) {
	key := settledKey(forge, repo, number)

	a.mu.Lock()
	idx := slices.IndexFunc(a.snap.PullRequests, func(pr PullRequest) bool {
		return settledKey(pr.Forge, pr.Repo, pr.Number) == key
	})
	if idx < 0 {
		a.mu.Unlock()

		return
	}
	now := a.now()

	a.botMu.Lock()
	a.updateRequests[key] = &updateEntry{
		Phase: UpdateQueued, RequestedAt: now, ExpiresAt: now.Add(updateQueuedWait),
		seq: a.fetchSeq.Load(),
	}
	a.botMu.Unlock()

	next := a.snap
	next.PullRequests = slices.Clone(a.snap.PullRequests)
	a.annotateBotRequests(next.PullRequests)
	a.snap = next
	a.mu.Unlock()

	a.notify(next)
}

// advanceUpdateRequests moves every update request that prs covers along.
// The caller holds botMu. seq and covers mean what they do for applyBotRequests.
func (a *Aggregator) advanceUpdateRequests(prs []PullRequest, seq uint64, covers func(Forge, string) bool) {
	if len(a.updateRequests) == 0 {
		return
	}

	now := a.now()
	listed := make(map[string]PullRequest, len(prs))
	for _, pr := range prs {
		listed[settledKey(pr.Forge, pr.Repo, pr.Number)] = pr
	}
	for key, e := range a.updateRequests {
		pr, present := listed[key]
		if !present {
			if botGone(key, covers) {
				delete(a.updateRequests, key)
			}

			continue
		}
		if !e.advance(pr, seq, now) {
			delete(a.updateRequests, key)
		}
	}
}

// advance applies one snapshot to the request and reports whether to keep it.
func (e *updateEntry) advance(pr PullRequest, seq uint64, now time.Time) bool {
	switch e.Phase {
	case UpdateQueued:
		switch {
		case seq > e.seq && !pr.Behind:
			return false
		case !now.Before(e.ExpiresAt):
			e.Phase = UpdateExpired
		}
	case UpdateExpired:
		if now.After(e.ExpiresAt.Add(updateExpiredKeep)) {
			return false
		}
	}

	return true
}

// updateRequestOf is pr's request from the registry, or nil. The caller holds botMu.
func (a *Aggregator) updateRequestOf(pr PullRequest) *UpdateRequest {
	e, ok := a.updateRequests[settledKey(pr.Forge, pr.Repo, pr.Number)]
	if !ok {
		return nil
	}
	req := e.UpdateRequest

	return &req
}
