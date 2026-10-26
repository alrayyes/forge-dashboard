package dashboard

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// EventClass groups webhook events by what they can tell the dashboard. A
// stream of comments says nothing about whether check deliveries still
// arrive, so each class keeps its own last-seen time.
type EventClass string

const (
	// EventClassCheck is a finished or started check: check_run or a commit
	// status.
	EventClassCheck EventClass = "check"
	// EventClassPullRequest is a pull_request event.
	EventClassPullRequest EventClass = "pull_request"
	// EventClassOther is every other event, a ping included.
	EventClassOther EventClass = "other"
)

// ClassifyEvent returns the class of a webhook event name as the forge sent
// it in its event header.
func ClassifyEvent(event string) EventClass {
	switch event {
	case "check_run", "status":
		return EventClassCheck
	case "pull_request":
		return EventClassPullRequest
	default:
		return EventClassOther
	}
}

// CredentialLabeler is implemented by a Source that can name the credential it
// talks to, the same label the API counters use. It never carries a secret.
type CredentialLabeler interface {
	CredentialLabel() string
}

type seenKey struct {
	forge      Forge
	credential string
	repo       string
	class      EventClass
}

// commitKey names one commit's check deliveries.
type commitKey struct {
	forge      Forge
	credential string
	repo       string
	sha        string
}

// commitRetention is how long a commit's last check delivery is remembered. It
// is far longer than any use the CI poll makes of it, so it only bounds memory.
const commitRetention = 24 * time.Hour

// webhookSeen is the in-memory webhook_seen record: when a delivery of each
// event class last arrived for a repo, keyed by forge, credential, repo and
// class, and when a check delivery last named each commit. It holds no user
// id. The zero value is ready to use.
type webhookSeen struct {
	mu      sync.Mutex
	last    map[seenKey]time.Time
	stored  map[seenKey]time.Time
	commits map[commitKey]time.Time
}

func (w *webhookSeen) mark(key seenKey, at time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.last == nil {
		w.last = make(map[seenKey]time.Time)
	}
	w.last[key] = at
}

// persistDue reports whether the store should hear of a delivery at at: no
// time is stored for key yet, or the stored one is seenWriteInterval old. It
// notes at as stored when it says yes, so the caller must then write it.
func (w *webhookSeen) persistDue(key seenKey, at time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.stored == nil {
		w.stored = make(map[seenKey]time.Time)
	}
	if prev, ok := w.stored[key]; ok && at.Sub(prev) < seenWriteInterval {
		return false
	}
	w.stored[key] = at

	return true
}

func (w *webhookSeen) get(key seenKey) (time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	at, ok := w.last[key]

	return at, ok
}

// markCommit records a check delivery for a commit and forgets the commits not
// named for commitRetention, so the record cannot grow with every push.
func (w *webhookSeen) markCommit(key commitKey, at time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.commits == nil {
		w.commits = make(map[commitKey]time.Time)
	}
	for k, seen := range w.commits {
		if at.Sub(seen) > commitRetention {
			delete(w.commits, k)
		}
	}
	w.commits[key] = at
}

func (w *webhookSeen) getCommit(key commitKey) (time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	at, ok := w.commits[key]

	return at, ok
}

// WithWebhookSeenStore keeps the webhook_seen record in store: the Aggregator
// starts from what the last run saved and saves each delivery as it arrives.
func WithWebhookSeenStore(store WebhookSeenStore) AggregatorOption {
	return func(a *Aggregator) { a.seenStore = store }
}

// restoreWebhookSeen loads the saved delivery times of every source's forge.
func (a *Aggregator) restoreWebhookSeen(ctx context.Context) {
	for _, src := range a.sources {
		forge := src.Forge()
		credential := a.credentialFor(forge)
		recs, err := a.seenStore.LoadWebhookSeen(ctx, forge, credential)
		if err != nil {
			slog.Warn("saved webhook deliveries unreadable, starting empty", "forge", forge, "error", err)

			continue
		}
		for _, rec := range recs {
			key := seenKey{forge, credential, rec.Repo, rec.Class}
			a.seen.mark(key, rec.At)
			a.seen.persistDue(key, rec.At) // what the store holds already
		}
	}
}

// seenWriteInterval is how long a stored delivery time is left as it is. A
// repo's deliveries arrive in bursts, and the store only has to know roughly
// when the last one came, so a burst costs one write.
const seenWriteInterval = time.Minute

// markSeen records a delivery in memory, and in the store unless the stored
// time for this repo and class is under seenWriteInterval old.
func (a *Aggregator) markSeen(forge Forge, credential, fullName string, class EventClass, at time.Time) {
	key := seenKey{forge, credential, fullName, class}
	a.seen.mark(key, at)
	if a.seenStore == nil || !a.seen.persistDue(key, at) {
		return
	}
	rec := SeenRecord{Repo: fullName, Class: class, At: at}
	if err := a.seenStore.SaveWebhookSeen(context.Background(), forge, credential, rec); err != nil {
		slog.Warn("could not save the webhook delivery", "forge", forge, "repo", fullName, "error", err)
	}
}

// credentialFor is the label of the credential the Source driving forge uses,
// or "" when none names one.
func (a *Aggregator) credentialFor(forge Forge) string {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if l, ok := src.(CredentialLabeler); ok {
			return l.CredentialLabel()
		}
	}

	return ""
}

// RecordDelivery notes that a webhook delivery of event arrived for
// forge/fullName, under the class the event belongs to.
func (a *Aggregator) RecordDelivery(forge Forge, fullName, event string) {
	a.markSeen(forge, a.credentialFor(forge), fullName, ClassifyEvent(event), a.now())
}

// RecordCheckDelivery notes that a check delivery arrived for forge/fullName
// that names the commit sha, so both the repo's check class and that commit
// count as seen. The caller has already tied sha to the signed body.
func (a *Aggregator) RecordCheckDelivery(forge Forge, fullName, sha string) {
	credential := a.credentialFor(forge)
	now := a.now()
	a.markSeen(forge, credential, fullName, EventClassCheck, now)
	a.seen.markCommit(commitKey{forge, credential, fullName, sha}, now)
}

// LastCheckDelivery is when a check delivery last named the commit sha of
// forge/fullName under the current credential, and whether one ever has.
func (a *Aggregator) LastCheckDelivery(forge Forge, fullName, sha string) (time.Time, bool) {
	return a.seen.getCommit(commitKey{forge, a.credentialFor(forge), fullName, sha})
}

// LastDelivery is when a delivery of class last arrived for forge/fullName
// under the current credential, and whether one ever has since the start.
func (a *Aggregator) LastDelivery(forge Forge, fullName string, class EventClass) (time.Time, bool) {
	return a.seen.get(seenKey{forge, a.credentialFor(forge), fullName, class})
}
