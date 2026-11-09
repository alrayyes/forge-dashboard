package forgejo

import (
	"fmt"
	"strings"
	"sync"
	"time"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// conflictWindow is how long a pull request whose mergeable flag is false on a
// moved base reads Checking before it reads Conflicting: about two refresh
// intervals, long enough for the forge's merge check to finish after a base
// push, short enough that a real conflict isn't hidden (#3304).
const conflictWindow = 90 * time.Second

// conflictTracker remembers when each unmergeable pull request on a moved base
// was first seen, by repo, number, head and base SHA. The flag alone can't
// tell a conflict from a check in progress, but a flag that stays false for the
// same head and base past the window is a conflict.
type conflictTracker struct {
	mu    sync.Mutex
	first map[string]time.Time
	now   func() time.Time
}

func newConflictTracker() *conflictTracker {
	return &conflictTracker{first: map[string]time.Time{}, now: time.Now}
}

// conflictPrefix is the key prefix every pull request of one repo shares.
func conflictPrefix(owner, name string) string {
	return fmt.Sprintf("%s/%s#", owner, name)
}

func conflictKey(owner, name string, p *gitea.PullRequest) string {
	head, base := "", ""
	if p.Head != nil {
		head = p.Head.Sha
	}
	if p.Base != nil {
		base = p.Base.Sha
	}

	return fmt.Sprintf("%s%d@%s@%s", conflictPrefix(owner, name), p.Index, head, base)
}

// status is Checking until key has been seen for conflictWindow, Conflicting
// after.
func (t *conflictTracker) status(key string) dashboard.MergeStatus {
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now()
	first, ok := t.first[key]
	if !ok {
		t.first[key] = now
		first = now
	}
	if now.Sub(first) >= conflictWindow {
		return dashboard.MergeConflicting
	}

	return dashboard.MergeChecking
}

// prune forgets every key of the repo that isn't in live: a pull request that
// closed, turned mergeable or moved to a new head or base.
func (t *conflictTracker) prune(owner, name string, live map[string]struct{}) {
	prefix := conflictPrefix(owner, name)

	t.mu.Lock()
	defer t.mu.Unlock()

	for key := range t.first {
		if _, ok := live[key]; !ok && strings.HasPrefix(key, prefix) {
			delete(t.first, key)
		}
	}
}
