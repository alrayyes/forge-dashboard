package dashboard

import (
	"slices"
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
	// costWindow is how many recent full refreshes a forge's cost is read from.
	costWindow = 3
)

// reserveOf is how much of rl is kept for user actions.
func reserveOf(rl RateLimit) int {
	return min(max(reserveFloor, int(float64(rl.Limit)*reserveFraction)), rl.Limit/2)
}

// costKey says which of a forge's budgets a full refresh was seen spending.
type costKey struct {
	forge   Forge
	graphQL bool
}

// reserveLedger remembers what the last few full refreshes cost, so a
// refresh is held back when it would cross the reserve, not only when it
// starts under it. It predicts the dearest of them: one refresh the ETag cache
// answered for nothing, or one that skipped a repo, says little about the next
// that goes to the forge.
type reserveLedger struct {
	mu   sync.Mutex
	cost map[costKey][]int
}

// lastCost is the dearest of the recent refreshes, or 0 before any was seen.
func (l *reserveLedger) lastCost(k costKey) int {
	l.mu.Lock()
	defer l.mu.Unlock()

	return slices.Max(append([]int{0}, l.cost[k]...))
}

func (l *reserveLedger) record(k costKey, points int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cost == nil {
		l.cost = make(map[costKey][]int)
	}
	l.cost[k] = append(l.cost[k], points)
	if over := len(l.cost[k]) - costWindow; over > 0 {
		l.cost[k] = l.cost[k][over:]
	}
}

// noteSpend learns what each Source's full refresh took from its budgets. It
// takes the Source's own count, not the fall in Remaining between two
// snapshots, which also holds every call that ran in between. A Source that
// did not measure or failed leaves the earlier figures alone. A refresh that
// skipped some repos still teaches what the others cost, or a repo that never
// reads would keep the hold from ever learning. A REST count of zero is a
// sample like any other, since a cached answer is free, but the hold goes by
// the dearest recent one.
func (a *Aggregator) noteSpend(results []Result) {
	for i, r := range results {
		if r.Spent == nil || !r.Health.Reachable || r.Health.Error != "" {
			continue
		}
		forge := a.sources[i].Forge()
		// A GraphQL fetch that worked cost at least a point, so none reported
		// is no measurement. REST can cost nothing: the cache answered.
		if r.Spent.GraphQL > 0 {
			a.reserve.record(costKey{forge, true}, r.Spent.GraphQL)
		}
		a.reserve.record(costKey{forge, false}, r.Spent.REST)
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
			if kind == apistats.KindFull {
				left -= a.reserve.lastCost(costKey{forge, graphQL})
			}
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
