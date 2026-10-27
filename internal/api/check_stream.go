package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// maxWatchedSubjects caps what one stream follows. The dialog shows one pull
// request or branch at a time, so a client asking for more is broken.
const maxWatchedSubjects = 8

const (
	subjectPullRequest = "pull_request"
	subjectMainBranch  = "main_branch"
)

var streamIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// checkSubject is a pull request or a default branch whose job list a page
// follows on the dashboard stream.
type checkSubject struct {
	Kind     string `json:"kind"`
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	Number   int    `json:"number,omitempty"`
}

// runEvent is the payload of the stream's named "run" event. A subject's job
// list is sent as one event for each workflow run attempt it holds, and one for
// each check that belongs to no run. Key names that unit, so a later event with
// the same key replaces the earlier one; Gone says the unit is no longer
// listed. The last event of a listing is marked Final, and an event with no
// Key and no Checks says the subject has none. An Error stands in for the
// whole listing.
type runEvent struct {
	checkSubject

	Key        string `json:"key,omitempty"`
	RunID      int64  `json:"runId,omitempty"`
	RunAttempt int64  `json:"runAttempt,omitempty"`
	// Status, Conclusion, StartedAt and CompletedAt are what the forge
	// reported about the run attempt itself. Each is left out where the forge
	// gave none, and always for a check that belongs to no run.
	Status      dashboard.CheckStatus     `json:"status,omitempty"`
	Conclusion  dashboard.CheckConclusion `json:"conclusion,omitempty"`
	StartedAt   *time.Time                `json:"startedAt,omitempty"`
	CompletedAt *time.Time                `json:"completedAt,omitempty"`
	Checks      []dashboard.Check         `json:"checks,omitempty"`
	Gone        bool                      `json:"gone,omitempty"`
	Final       bool                      `json:"final,omitempty"`
	Error       string                    `json:"error,omitempty"`
}

// runGroup is the jobs of one run attempt, or one check that has no run.
type runGroup struct {
	key        string
	runID      int64
	runAttempt int64
	checks     []dashboard.Check
	// run is what the forge said about the run attempt, taken from its first
	// job that carries it.
	run *dashboard.RunFacts
}

// groupRuns splits a job list by run and attempt, in the order each first
// appears. A rerun keeps its run id and moves to a new attempt, so the pair is
// what tells one from the other. A check without a run is a group of its own,
// named by its address and name.
func groupRuns(checks []dashboard.Check) []runGroup {
	var groups []runGroup
	at := map[string]int{}
	for _, c := range checks {
		key := fmt.Sprintf("job/%s|%s", c.URL, c.Name)
		if c.RunID > 0 {
			key = fmt.Sprintf("run/%d/%d", c.RunID, c.RunAttempt)
		}
		i, ok := at[key]
		if !ok {
			i = len(groups)
			at[key] = i
			groups = append(groups, runGroup{key: key, runID: c.RunID, runAttempt: c.RunAttempt})
		}
		groups[i].checks = append(groups[i].checks, c)
		if groups[i].run == nil && c.RunID > 0 {
			groups[i].run = c.Run
		}
	}

	return groups
}

// checkWatches tracks which subjects each open stream follows. It is created
// once in NewMux, since Deps is passed by value.
type checkWatches struct {
	mu      sync.Mutex
	streams map[string]*checkWatch
}

func newCheckWatches() *checkWatches {
	return &checkWatches{streams: map[string]*checkWatch{}}
}

// open registers a stream under id. A reconnecting EventSource reuses its URL,
// so a second open for the same id replaces the first, which starts empty. It
// returns nil for an id that is not well formed, and that stream watches
// nothing.
func (c *checkWatches) open(ctx context.Context, deps Deps, id string) *checkWatch {
	if !streamIDPattern.MatchString(id) {
		return nil
	}
	w := &checkWatch{
		ctx:     apistats.WithKind(ctx, apistats.KindDetails),
		out:     make(chan []byte, maxWatchedSubjects*2),
		watched: map[checkSubject]*watchedSubject{},
	}
	w.snapshot = deps.Service.Get
	w.fetch = func(ctx context.Context, s checkSubject) ([]dashboard.Check, *statusError) {
		if s.Kind == subjectPullRequest {
			return resolvePullRequestChecksFor(ctx, deps, s.Forge, s.FullName, s.Number)
		}

		return resolveMainBranchChecksFor(ctx, deps, s.Forge, s.FullName)
	}
	c.mu.Lock()
	c.streams[id] = w
	c.mu.Unlock()

	return w
}

func (c *checkWatches) close(id string, w *checkWatch) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.streams[id] == w {
		delete(c.streams, id)
	}
}

func (c *checkWatches) find(id string) *checkWatch {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.streams[id]
}

// watchedSubject remembers the snapshot row a job list was last fetched for, so
// the next snapshot lists again only when that row moved. gen drops the result
// of a fetch that a newer one overtook.
type watchedSubject struct {
	sig string
	gen int
	// sent holds the keys of the runs the last listing sent, so the next one
	// can say which are gone.
	sent []string
	// send is held from working out a listing's events until the last is
	// handed over, so two listings of one subject reach the page one after the
	// other, in the order their events were worked out.
	send sync.Mutex
}

// retrySig never equals a row's signature, so the next snapshot lists again
// after a failed fetch.
const retrySig = "retry"

// checkWatch is one stream's watched subjects. Fetches run in their own
// goroutines and hand finished events to out, which the stream goroutine, the
// only writer to the response, drains.
type checkWatch struct {
	ctx context.Context
	out chan []byte

	// fetch lists one subject's jobs and snapshot reads the current rows. They
	// are fields so a test can drive the watch without a forge.
	fetch    func(context.Context, checkSubject) ([]dashboard.Check, *statusError)
	snapshot func() dashboard.Snapshot

	mu      sync.Mutex
	watched map[checkSubject]*watchedSubject
}

// set replaces the watched subjects. A subject already watched is listed again
// only when refresh is set; a new one is always listed.
func (w *checkWatch) set(subjects []checkSubject, refresh bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	next := make(map[checkSubject]*watchedSubject, len(subjects))
	for _, s := range subjects {
		held, known := w.watched[s]
		if !known {
			held = &watchedSubject{}
		}
		next[s] = held
		if !known || refresh {
			w.listLocked(s, held)
		}
	}
	w.watched = next
}

// onSnapshot lists again every watched subject whose row changed.
func (w *checkWatch) onSnapshot(snap dashboard.Snapshot) {
	w.mu.Lock()
	defer w.mu.Unlock()

	for s, held := range w.watched {
		sig, found := rowSignature(snap, s)
		if found && sig != held.sig {
			w.listLocked(s, held)
		}
	}
}

func (w *checkWatch) listLocked(s checkSubject, held *watchedSubject) {
	held.gen++
	gen := held.gen
	held.sig, _ = rowSignature(w.snapshot(), s)

	go w.list(s, held, gen)
}

func (w *checkWatch) list(s checkSubject, held *watchedSubject, gen int) {
	checks, serr := w.fetch(w.ctx, s)

	held.send.Lock()
	defer held.send.Unlock()

	w.mu.Lock()
	current := w.watched[s] == held && held.gen == gen
	var events []runEvent
	if current {
		if serr != nil {
			held.sig = retrySig
			events = []runEvent{{checkSubject: s, Error: serr.message}}
		} else {
			events = held.events(s, checks)
		}
	}
	w.mu.Unlock()

	for _, ev := range events {
		data, err := json.Marshal(ev)
		if err != nil {
			// A listing with a hole in it is no use to the page, which would
			// wait for a final event that never comes. Say it failed, and have
			// the next snapshot list again.
			w.mu.Lock()
			held.sig = retrySig
			w.mu.Unlock()
			w.emit(runEvent{checkSubject: s, Error: "could not encode the checks"})

			return
		}
		if !w.deliver(data) {
			return
		}
	}
}

// emit hands one event to the stream, answering false once it has closed.
func (w *checkWatch) emit(ev runEvent) bool {
	data, err := json.Marshal(ev)
	if err != nil {
		return false
	}

	return w.deliver(data)
}

func (w *checkWatch) deliver(data []byte) bool {
	select {
	case w.out <- data:
		return true
	case <-w.ctx.Done():
		return false
	}
}

// events turns one job list into the run events that bring a page up to date:
// every run, then each run the last listing sent and this one lacks. The caller
// holds the watch's lock.
func (held *watchedSubject) events(s checkSubject, checks []dashboard.Check) []runEvent {
	groups := groupRuns(checks)
	listed := make(map[string]bool, len(groups))
	events := make([]runEvent, 0, len(groups)+len(held.sent))
	for _, g := range groups {
		listed[g.key] = true
		ev := runEvent{
			checkSubject: s, Key: g.key, RunID: g.runID, RunAttempt: g.runAttempt, Checks: g.checks,
		}
		if g.run != nil {
			ev.Status, ev.Conclusion = g.run.Status, g.run.Conclusion
			ev.StartedAt, ev.CompletedAt = g.run.StartedAt, g.run.CompletedAt
		}
		events = append(events, ev)
	}
	for _, key := range held.sent {
		if !listed[key] {
			events = append(events, runEvent{checkSubject: s, Key: key, Gone: true})
		}
	}
	held.sent = held.sent[:0:0]
	for _, g := range groups {
		held.sent = append(held.sent, g.key)
	}
	if len(events) == 0 {
		events = append(events, runEvent{checkSubject: s})
	}
	events[len(events)-1].Final = true

	return events
}

// rowSignature says what about a subject's row in snap means its job list may
// have changed. found is false when the snapshot has no such row.
func rowSignature(snap dashboard.Snapshot, s checkSubject) (sig string, found bool) {
	switch s.Kind {
	case subjectPullRequest:
		for _, pr := range snap.PullRequests {
			if string(pr.Forge) == s.Forge && pr.Repo == s.FullName && pr.Number == s.Number {
				return fmt.Sprintf("%s|%+v", pr.CI, pr.Checks), true
			}
		}
	case subjectMainBranch:
		for _, b := range snap.MainBranches {
			if string(b.Forge) == s.Forge && b.FullName == s.FullName {
				return fmt.Sprintf("%s|%+v|%s", b.Status, b.Checks, b.RunURL), true
			}
		}
	}

	return "", false
}

type watchRequest struct {
	StreamID string         `json:"streamId"`
	Subjects []checkSubject `json:"subjects"`
	Refresh  bool           `json:"refresh"`
}

// handleStreamWatch sets which pull requests and branches a dashboard stream
// sends job lists for. The lists come back as "run" events on that stream.
func handleStreamWatch(watches *checkWatches) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req watchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid JSON body"))

			return
		}
		if msg := validateSubjects(req.Subjects); msg != "" {
			writeJSON(w, http.StatusBadRequest, errorBody(msg))

			return
		}
		watch := watches.find(req.StreamID)
		if watch == nil {
			writeJSON(w, http.StatusNotFound, errorBody("no such stream"))

			return
		}

		watch.set(req.Subjects, req.Refresh)
		w.WriteHeader(http.StatusNoContent)
	}
}

func validateSubjects(subjects []checkSubject) string {
	if len(subjects) > maxWatchedSubjects {
		return fmt.Sprintf("at most %d subjects", maxWatchedSubjects)
	}
	for _, s := range subjects {
		if _, _, ok := splitFullName(s.FullName); !ok || s.Forge == "" {
			return `each subject needs a forge and a fullName of the form "owner/repo"`
		}
		switch {
		case s.Kind == subjectPullRequest && s.Number > 0:
		case s.Kind == subjectMainBranch && s.Number == 0:
		default:
			return "each subject is a pull_request with a number or a main_branch"
		}
	}

	return ""
}
