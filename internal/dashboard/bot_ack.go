package dashboard

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// ackLookup is one pending Dependabot request to ask the forge about.
type ackLookup struct {
	forge       Forge
	owner, name string
	number      int
	key         string
	requestedAt time.Time
}

// checkDependabotAcks asks the forge whether Dependabot has reacted to the
// command comment of each Dependabot rebase request still waiting for it, and
// records the answer (#1082). It runs before a refresh settles the requests,
// outside every lock, since it talks to the forge. A forge that can't say, or
// fails, leaves the request as it was: the row shows the plain requested
// state, never an error.
func (a *Aggregator) checkDependabotAcks(ctx context.Context) {
	for _, l := range a.pendingAcks() {
		reader := a.ackReaderFor(l.forge)
		if reader == nil {
			continue
		}
		ack, err := reader.DependabotAck(ctx, l.owner, l.name, l.number, DependabotRebaseComment, l.requestedAt)
		if err != nil {
			slog.Warn("dependabot acknowledgement lookup failed", "forge", l.forge, "repo", l.owner+"/"+l.name, "number", l.number, "error", err)

			continue
		}
		a.recordAck(l, ack)
	}
}

// pendingAcks lists the Dependabot rebase requests that haven't been seen
// acknowledged. An expired one is still asked about: a late thumbs-up means
// Dependabot did get the command after all. A rebasing one already proves it.
func (a *Aggregator) pendingAcks() []ackLookup {
	a.botMu.Lock()
	defer a.botMu.Unlock()

	var out []ackLookup
	for key, e := range a.botRequests {
		if e.Bot != BotDependabot || e.Action != BotRebase || e.AcknowledgedAt != nil || e.Phase == BotRebasing {
			continue
		}
		forge, repo := splitSettledKey(key)
		owner, name, ok := strings.Cut(repo, "/")
		if !ok {
			continue
		}
		number, err := strconv.Atoi(key[strings.LastIndex(key, "#")+1:])
		if err != nil {
			continue
		}
		out = append(out, ackLookup{forge: forge, owner: owner, name: name, number: number, key: key, requestedAt: e.RequestedAt})
	}

	return out
}

// recordAck writes what the forge said onto the request, unless it was
// replaced by a newer one in the meantime.
func (a *Aggregator) recordAck(l ackLookup, ack CommandAck) {
	a.botMu.Lock()
	defer a.botMu.Unlock()

	e, ok := a.botRequests[l.key]
	if !ok || !e.RequestedAt.Equal(l.requestedAt) {
		return
	}
	if ack.CommentURL != "" {
		e.CommentURL = ack.CommentURL
	}
	if !ack.Acknowledged {
		return
	}
	now := a.now()
	e.AcknowledgedAt = &now
	if e.Phase == BotQueued || e.Phase == BotExpired {
		e.Phase, e.ExpiresAt = BotQueued, now.Add(botQueuedWait)
	}
}

// ackReaderFor returns the configured Source driving forge, if it can read
// Dependabot's reactions.
func (a *Aggregator) ackReaderFor(forge Forge) DependabotAckReader {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if r, ok := src.(DependabotAckReader); ok {
			return r
		}

		return nil
	}

	return nil
}
