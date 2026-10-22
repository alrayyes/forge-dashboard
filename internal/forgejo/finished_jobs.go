package forgejo

import (
	"sync"
	"time"

	"code.gitea.io/sdk/gitea"
)

// finishedJobs keeps the job list of a finished run, which never changes, so a
// default-branch poll only re-reads the runs still going. Forgejo sends no ETag
// to make that read a 304. Keyed by run and finish time, so a rerun, which
// finishes again later, is read afresh. Past max entries the least recently
// read go first.
type finishedJobs struct {
	mu   sync.Mutex
	jobs *lru[[]*gitea.ActionWorkflowJob]
}

// maxFinishedJobs bounds a client's finishedJobs.
const maxFinishedJobs = 2000

func newFinishedJobs(limit int) *finishedJobs {
	return &finishedJobs{jobs: newLRU[[]*gitea.ActionWorkflowJob](limit)}
}

func (f *finishedJobs) get(key string) ([]*gitea.ActionWorkflowJob, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.jobs.get(key)
}

func (f *finishedJobs) put(key string, jobs []*gitea.ActionWorkflowJob) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.jobs.put(key, jobs)
}

// excerptCache keeps the log excerpt of each finished failed job, keyed by job
// and finish time, with the same least-recently-read bound as finishedJobs.
type excerptCache struct {
	mu   sync.Mutex
	text *lru[keptExcerpt]
	// failed is when each key's read last failed, so a log that can't be read
	// isn't asked for again within failedExcerptDelay.
	failed map[string]time.Time
	max    int
	now    func() time.Time
}

// keptExcerpt is an excerpt and when it stops being trusted: the zero time for
// one read from a settled log, which never changes.
type keptExcerpt struct {
	text  string
	until time.Time
}

// failedExcerptDelay is how long a failed read is remembered, and how long an
// excerpt read before its log had settled is kept.
const failedExcerptDelay = time.Minute

// excerptSettleDelay is how long after a job finishes its log is trusted to be
// complete. The runner may still be flushing its last lines just after.
const excerptSettleDelay = 30 * time.Second

// maxExcerpts bounds a client's excerptCache; an excerpt is at most 2 KB.
const maxExcerpts = 500

func newExcerptCache(limit int) *excerptCache {
	return &excerptCache{max: limit, text: newLRU[keptExcerpt](limit), failed: map[string]time.Time{}, now: time.Now}
}

func (e *excerptCache) get(key string) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	kept, ok := e.text.get(key)
	if !ok {
		return "", false
	}
	if !kept.until.IsZero() && !e.now().Before(kept.until) {
		e.text.remove(key)

		return "", false
	}

	return kept.text, true
}

// put keeps text under key. A final excerpt (read from a log that had settled)
// is kept for good; any other is kept for failedExcerptDelay, so a log that was
// only partly flushed is read once more.
func (e *excerptCache) put(key, text string, final bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	kept := keptExcerpt{text: text}
	if !final {
		kept.until = e.now().Add(failedExcerptDelay)
	}
	e.text.put(key, kept)
}

// fail remembers that key's log couldn't be read just now. Expired entries are
// swept on each call, which is cheap at maxExcerpts; if the memory is full of
// live entries a new failure is not remembered, and that log is asked for again
// next poll, which is all that costs.
func (e *excerptCache) fail(key string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	for k, at := range e.failed {
		if now.Sub(at) >= failedExcerptDelay {
			delete(e.failed, k)
		}
	}
	if len(e.failed) < e.max {
		e.failed[key] = now
	}
}

// recentlyFailed reports whether key's read failed within failedExcerptDelay.
func (e *excerptCache) recentlyFailed(key string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	at, ok := e.failed[key]

	return ok && e.now().Sub(at) < failedExcerptDelay
}
