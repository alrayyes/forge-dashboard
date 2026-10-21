package dashboard

import (
	"sync"
	"time"
)

// EventClass groups webhook events by what they can tell the dashboard. A
// stream of comments says nothing about whether check deliveries still
// arrive, so each class keeps its own last-seen time.
type EventClass string

const (
	// EventClassCheck is a finished or started check: check_run, check_suite
	// or a commit status.
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
	case "check_run", "check_suite", "status":
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

// webhookSeen is the in-memory webhook_seen record: when a delivery of each
// event class last arrived for a repo, keyed by forge, credential, repo and
// class. It holds no user id. The zero value is ready to use.
type webhookSeen struct {
	mu   sync.Mutex
	last map[seenKey]time.Time
}

func (w *webhookSeen) mark(key seenKey, at time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.last == nil {
		w.last = make(map[seenKey]time.Time)
	}
	w.last[key] = at
}

func (w *webhookSeen) get(key seenKey) (time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	at, ok := w.last[key]

	return at, ok
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
	a.seen.mark(seenKey{forge, a.credentialFor(forge), fullName, ClassifyEvent(event)}, a.now())
}

// LastDelivery is when a delivery of class last arrived for forge/fullName
// under the current credential, and whether one ever has since the start.
func (a *Aggregator) LastDelivery(forge Forge, fullName string, class EventClass) (time.Time, bool) {
	return a.seen.get(seenKey{forge, a.credentialFor(forge), fullName, class})
}
