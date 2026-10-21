package forgejo

import (
	"slices"
	"sync"

	"code.gitea.io/sdk/gitea"
)

// finishedJobs keeps the job list of a finished run, which never changes, so a
// default-branch poll only re-reads the runs still going. Forgejo sends no ETag
// to make that read a 304. Keyed by run and finish time, so a rerun, which
// finishes again later, is read afresh. Past max entries the least recently
// read go first.
type finishedJobs struct {
	mu    sync.Mutex
	max   int
	jobs  map[string][]*gitea.ActionWorkflowJob
	order []string // keys, least recently read first
}

// maxFinishedJobs bounds a client's finishedJobs.
const maxFinishedJobs = 2000

func newFinishedJobs(limit int) *finishedJobs {
	return &finishedJobs{max: limit, jobs: map[string][]*gitea.ActionWorkflowJob{}}
}

func (f *finishedJobs) get(key string) ([]*gitea.ActionWorkflowJob, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	jobs, ok := f.jobs[key]
	if ok {
		f.touch(key)
	}

	return jobs, ok
}

func (f *finishedJobs) put(key string, jobs []*gitea.ActionWorkflowJob) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.jobs[key]; ok {
		f.touch(key)
	} else {
		f.order = append(f.order, key)
	}
	f.jobs[key] = jobs
	for len(f.order) > f.max {
		delete(f.jobs, f.order[0])
		f.order = f.order[1:]
	}
}

// touch moves key to the end of the order, as the most recently read.
func (f *finishedJobs) touch(key string) {
	if i := slices.Index(f.order, key); i >= 0 {
		f.order = append(slices.Delete(f.order, i, i+1), key)
	}
}
