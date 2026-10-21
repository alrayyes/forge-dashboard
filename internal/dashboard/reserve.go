package dashboard

import (
	"sync"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
)

const (
	// reserveFraction of a forge's budget is held back for the person at the
	// keyboard: background work stops short of it.
	reserveFraction = 0.10
	// reserveFloor is the least a reserve ever is, so a small budget still
	// leaves room for a few clicks. It never exceeds half the budget.
	reserveFloor = 50
)

// reserveOf is how much of rl is kept for user actions.
func reserveOf(rl RateLimit) int {
	return min(max(reserveFloor, int(float64(rl.Limit)*reserveFraction)), rl.Limit/2)
}

// costKey says which budget a kind of background work was last seen spending.
type costKey struct {
	forge   Forge
	graphQL bool
	kind    apistats.Kind
}

// reserveLedger remembers what the last background full refresh cost, so a
// refresh is held back when it would cross the reserve, not only when it
// starts under it.
type reserveLedger struct {
	mu   sync.Mutex
	cost map[costKey]int
}

func (l *reserveLedger) lastCost(k costKey) int {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.cost[k]
}

func (l *reserveLedger) record(k costKey, points int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cost == nil {
		l.cost = make(map[costKey]int)
	}
	l.cost[k] = points
}

// noteBudget logs the budget changes a refresh brought and learns its cost.
func (a *Aggregator) noteBudget(before, after Snapshot) {
	a.recordFullCost(before, after)
	logRateLimitTransitions(before.Forges, after.Forges)
}

// recordFullCost notes what a full refresh took from each of forge's budgets,
// read as how far Remaining fell within one reset window. A window that rolled
// over, or a budget that rose, says nothing about the cost and is ignored.
func (a *Aggregator) recordFullCost(before, after Snapshot) {
	for _, h := range after.Forges {
		prev, ok := healthOf(before, h.Forge)
		if !ok {
			continue
		}
		for _, graphQL := range []bool{true, false} {
			was, now := budgetOf(prev, graphQL), budgetOf(h, graphQL)
			if was == nil || now == nil || !was.ResetsAt.Equal(now.ResetsAt) || now.Remaining >= was.Remaining {
				continue
			}
			a.reserve.record(costKey{h.Forge, graphQL, apistats.KindFull}, was.Remaining-now.Remaining)
		}
	}
}

func budgetOf(h ForgeHealth, graphQL bool) *RateLimit {
	if graphQL {
		return h.RateLimitGraphQL
	}

	return h.RateLimitREST
}

// budgetHold reports whether background work of this kind should not call
// forge now. A scoped webhook refresh is held only when a budget is spent,
// since it is cheap and is the path that keeps the board current. Every other
// background kind (full refresh, polls, hook maintenance) waits when it would
// leave either budget at or under its reserve, REST work included when only
// GraphQL is low and the reverse: one check is simpler than tracking which
// budget each kind spends. A budget the forge does not report has no reserve,
// so Forgejo is never held. User actions never ask.
func (a *Aggregator) budgetHold(snap Snapshot, forge Forge, kind apistats.Kind) bool {
	h, ok := healthOf(snap, forge)
	if !ok {
		return false
	}
	now := a.now()
	for _, graphQL := range []bool{true, false} {
		rl := budgetOf(h, graphQL)
		if rl == nil || rl.Limit <= 0 || !rl.ResetsAt.After(now) {
			continue
		}
		left := rl.Remaining
		if kind != apistats.KindScopedWebhook {
			left -= a.reserve.lastCost(costKey{forge, graphQL, kind})
			if left > reserveOf(*rl) {
				continue
			}
		} else if left > 0 {
			continue
		}

		return true
	}

	return false
}
