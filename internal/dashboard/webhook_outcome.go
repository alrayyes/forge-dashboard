package dashboard

import (
	"errors"
	"strings"
	"time"
)

// WebhookReason says why the automatic pass left a repo without a hook (#4682).
// A repo the token can't administer has no outcome here: the repo's own
// CanManageWebhooks already says so.
type WebhookReason string

const (
	// WebhookUnavailable means the forge was rate limited, unreachable or
	// failing on its side, so the pass left the repo for a later refresh.
	WebhookUnavailable WebhookReason = "forge_unavailable"
	// WebhookRefused means the forge answered the create with a refusal.
	WebhookRefused WebhookReason = "forge_refused"
)

// WebhookOutcome is what the last attempt to create one repo's hook came to,
// when it didn't end in a hook.
type WebhookOutcome struct {
	Reason WebhookReason
	// Detail is the forge's reason in one line, for a refusal.
	Detail string
	// NextAttempt is when the pass asks the forge again. Zero when the next
	// refresh does, as for an unavailable forge.
	NextAttempt time.Time
}

// ForgeServesHookWork reports whether a forge answered its last refresh and
// has REST budget left, so the hook pass will talk to it.
func ForgeServesHookWork(h ForgeHealth) bool {
	return h.Reachable && (h.RateLimitREST == nil || h.RateLimitREST.Remaining > 0)
}

// Outcome returns what the last attempt to create fullName's hook on forge
// came to, if it left the repo without one.
func (w *WebhookUpgrades) Outcome(forge Forge, fullName string) (WebhookOutcome, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	o, ok := w.outcomes[outcomeKey(forge, fullName)]

	return o, ok
}

// WebhookOutcome is Outcome for the Service's own record. False when hook
// maintenance is off.
func (s *Service) WebhookOutcome(forge Forge, fullName string) (WebhookOutcome, bool) {
	s.mu.Lock()
	state := s.webhookUpgrade
	s.mu.Unlock()
	if state == nil {
		return WebhookOutcome{}, false
	}

	return state.Outcome(forge, fullName)
}

func outcomeKey(forge Forge, fullName string) string {
	return string(forge) + "|" + fullName
}

// prune drops the outcomes whose cause is gone: every outcome while the public
// origin is unusable, since the pass makes no attempt and a refusal would
// promise a next try that never comes; and, for each forge in healthy, the
// outcome of a repo that left the snapshot or has a hook now. A forge that
// failed its refresh keeps its outcomes, as its snapshot is not to be trusted.
func (w *WebhookUpgrades) prune(snap Snapshot, healthy map[Forge]bool, originProblem string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if originProblem != "" {
		clear(w.outcomes)

		return
	}
	pending := make(map[string]bool, len(snap.Repos))
	for _, r := range snap.Repos {
		if !r.HasWebhook && r.CanManageWebhooks {
			pending[outcomeKey(r.Forge, r.FullName)] = true
		}
	}
	for key := range w.outcomes {
		forge, _, _ := strings.Cut(key, "|")
		if healthy[Forge(forge)] && !pending[key] {
			delete(w.outcomes, key)
		}
	}
}

// forgeOwnWords is what the forge itself said about a refusal, or "" when all
// there is to show is the dashboard's own sentence for the status.
func forgeOwnWords(err error) string {
	clientErr, ok := errors.AsType[*ClientError](err)
	if !ok {
		return ""
	}
	// The ClientError's own text, without the pass's "ensure hook:" wrapper.
	if text := ForgeMessage(clientErr); isPlainSentence(text) {
		return strings.TrimSpace(text)
	}

	return ""
}

// record keeps the outcome of a create job, or drops it when o is nil.
func (w *WebhookUpgrades) record(forge Forge, fullName, retryKey string, o *WebhookOutcome) {
	w.mu.Lock()
	defer w.mu.Unlock()
	key := outcomeKey(forge, fullName)
	if o == nil {
		delete(w.outcomes, key)

		return
	}
	if o.Reason == WebhookRefused {
		o.NextAttempt = w.next[retryKey]
	}
	w.outcomes[key] = *o
}
