package forgejo

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
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
	// refused holds the files a refused merge or update named, for keys whose
	// refusal named a conflict. Same key as first, so a new head or base
	// leaves it behind and prune drops it with the rest (#3308).
	refused map[string][]string
	now     func() time.Time
}

func newConflictTracker() *conflictTracker {
	return &conflictTracker{first: map[string]time.Time{}, refused: map[string][]string{}, now: time.Now}
}

// conflictVerdict is what a row says about a pull request whose flag is false
// on a moved base. Confirmed is nil while it is still Checking.
type conflictVerdict struct {
	Status    dashboard.MergeStatus
	Confirmed *bool
	Files     []string
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
// after. A key whose merge or update was refused naming a conflict is
// Conflicting, confirmed, at once. Past the window with no such refusal it is
// Conflicting but not confirmed: the flag alone is all there is.
func (t *conflictTracker) status(key string) conflictVerdict {
	t.mu.Lock()
	defer t.mu.Unlock()

	if files, ok := t.refused[key]; ok {
		yes := true

		return conflictVerdict{Status: dashboard.MergeConflicting, Confirmed: &yes, Files: files}
	}

	now := t.now()
	first, ok := t.first[key]
	if !ok {
		t.first[key] = now
		first = now
	}
	if now.Sub(first) >= conflictWindow {
		no := false

		return conflictVerdict{Status: dashboard.MergeConflicting, Confirmed: &no}
	}

	return conflictVerdict{Status: dashboard.MergeChecking}
}

// remember notes that a merge or update of owner/name#number was refused
// naming a conflict, in files when it said which. It attaches to the head and
// base the row was last drawn with. A pull request the tracker has not seen
// unmergeable on a moved base has no such row, so nothing is kept.
func (t *conflictTracker) remember(owner, name string, number int64, files []string) {
	prefix := fmt.Sprintf("%s%d@", conflictPrefix(owner, name), number)

	t.mu.Lock()
	defer t.mu.Unlock()

	for key := range t.first {
		if strings.HasPrefix(key, prefix) {
			t.refused[key] = files
		}
	}
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
			delete(t.refused, key)
		}
	}
}

// conflictRefusal is a 409 that names a merge conflict, as Forgejo answers a
// merge or an update that git could not complete. It keeps the files git
// named, and wraps the plain refusal so every caller still reads it as one.
type conflictRefusal struct {
	err   error
	files []string
}

func (e *conflictRefusal) Error() string { return e.err.Error() }
func (e *conflictRefusal) Unwrap() error { return e.err }

// maxConflictFiles caps the files kept per pull request: a rebase of a large
// change can name hundreds, and the row shows a handful.
const maxConflictFiles = 20

// conflictFile matches the files git names: "Merge conflict in x" for two
// edits, "x deleted in" for an edit against a delete.
var conflictFile = regexp.MustCompile(`(?m)CONFLICT \([^)]*\): (?:Merge conflict in (.+?)|(.+?) deleted in .*)\s*$`)

// conflictFromBody reports whether a 409 body from Forgejo's merge or update
// names a conflict, and which files. The merge endpoint serialises git's
// output as StdOut and StdErr, the update endpoint wraps the same text in
// "message". Git's own "CONFLICT (" lines are the proof. Only the update
// endpoint's message, which has no git output beside it, may say "conflict" in
// plain words. Anything else on a 409 (a head that moved, a merged pull
// request, a StdOut that merely mentions the word) does not.
func conflictFromBody(body []byte) ([]string, bool) {
	text := string(body)
	var decoded struct {
		Message string `json:"message"`
		StdOut  *string
		StdErr  string
	}
	updateMessage := false
	if json.Unmarshal(body, &decoded) == nil {
		updateMessage = decoded.StdOut == nil && decoded.StdErr == "" && decoded.Message != ""
		text = decoded.Message + "\n" + decoded.StdErr
		if decoded.StdOut != nil {
			text += "\n" + *decoded.StdOut
		}
	}

	var files []string
	seen := map[string]bool{}
	for _, m := range conflictFile.FindAllStringSubmatch(text, -1) {
		file := m[1]
		if file == "" {
			file = m[2]
		}
		if file == "" || seen[file] || len(files) >= maxConflictFiles {
			continue
		}
		seen[file] = true
		files = append(files, file)
	}
	named := len(files) > 0 || strings.Contains(text, "CONFLICT (") ||
		(updateMessage && strings.Contains(strings.ToLower(decoded.Message), "conflict"))

	return files, named
}

// rememberConflict notes a refused merge or update that named a conflict, so
// the row says Conflicting before the check window ends.
func (c *Client) rememberConflict(owner, name string, number int, err error) {
	if refusal, ok := errors.AsType[*conflictRefusal](err); ok {
		c.conflicts.remember(owner, name, int64(number), refusal.files)
	}
}
