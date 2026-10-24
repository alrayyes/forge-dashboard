package forgejo_test

import (
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"testing"
)

// fakeJobs plays the job routes of a Forgejo 17 for alrayyes/a: the jobs of
// each run, and the job rerun. jobs maps a run id to its jobs. cascade maps a
// job to the jobs the forge restarts with it, which then read as waiting. status
// is what the job rerun answers (0 for 204).
type fakeJobs struct {
	jobs    map[int][]map[string]any
	cascade map[int][]int
	status  int

	mu       sync.Mutex
	rerun    []string
	listings int
}

func job(id int, status string) map[string]any {
	return map[string]any{"id": id, "name": fmt.Sprintf("job-%d", id), "status": status}
}

func (f *fakeJobs) register(t *testing.T, mux *http.ServeMux) {
	t.Helper()
	mux.HandleFunc("GET /api/v1/repos/alrayyes/a/actions/runs/{run}/jobs", func(w http.ResponseWriter, r *http.Request) {
		run, _ := strconv.Atoi(r.PathValue("run"))
		f.mu.Lock()
		f.listings++
		jobs := append([]map[string]any(nil), f.jobs[run]...)
		f.mu.Unlock()
		writeJSON(t, w, map[string]any{"total_count": len(jobs), "jobs": jobs})
	})
	mux.HandleFunc("POST /api/v1/repos/alrayyes/a/actions/jobs/{job}/rerun", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.Atoi(r.PathValue("job"))
		f.mu.Lock()
		f.rerun = append(f.rerun, r.PathValue("job"))
		f.restart(id)
		f.mu.Unlock()
		if f.status != 0 {
			w.WriteHeader(f.status)
			writeJSON(t, w, map[string]any{"message": "token does not have at least one of required scope(s)"})

			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// restart reads job id and everything the forge restarts with it as waiting.
func (f *fakeJobs) restart(id int) {
	restarted := map[int]bool{id: true}
	for _, d := range f.cascade[id] {
		restarted[d] = true
	}
	for _, jobs := range f.jobs {
		for _, j := range jobs {
			if n, _ := j["id"].(int); restarted[n] {
				j["status"] = "waiting"
			}
		}
	}
}

// rerunsSeen is the job ids asked to rerun, in order.
func (f *fakeJobs) rerunsSeen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.rerun...)
}

func (f *fakeJobs) listingsSeen() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.listings
}
