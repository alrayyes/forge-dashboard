package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// What the external tests (package api_test) may reach of the package's
// unexported parsers, for fuzzing them without widening the real API.
var (
	RepoFromPayload = repoFromPayload
	ValidSignature  = validSignature

	NewStaticHandler = newStaticHandler
	RecoverPanics    = recoverPanics

	BotActionNotOffered = botActionNotOffered

	InjectFooterVersion = injectFooterVersion
	StaticFiles         = staticFiles
)

// CheckWatch is the stream's watch of job lists, reachable for tests that
// drive it with a fetch of their own.
type (
	CheckWatch   = checkWatch
	CheckSubject = checkSubject
)

// NewCheckWatch builds a watch whose lists come from fetch and whose rows come
// from snapshot. A fetch error is reported as a 502.
func NewCheckWatch(ctx context.Context, fetch func(CheckSubject) ([]dashboard.Check, error), snapshot func() dashboard.Snapshot) *CheckWatch {
	return &checkWatch{
		ctx: ctx,
		out: make(chan []byte, maxWatchedSubjects*2),
		fetch: func(_ context.Context, s checkSubject) ([]dashboard.Check, *statusError) {
			checks, err := fetch(s)
			if err != nil {
				return nil, &statusError{http.StatusBadGateway, err.Error()}
			}

			return checks, nil
		},
		snapshot: snapshot,
		watched:  map[checkSubject]*watchedSubject{},
	}
}

func (w *checkWatch) Set(subjects []checkSubject, refresh bool) { w.set(subjects, refresh) }
func (w *checkWatch) OnSnapshot(snap dashboard.Snapshot)        { w.onSnapshot(snap) }
func (w *checkWatch) Out() <-chan []byte                        { return w.out }
func (w *checkWatch) Watching() int {
	w.mu.Lock()
	defer w.mu.Unlock()

	return len(w.watched)
}

// CheckWatches is the registry of open streams' watches.
type CheckWatches = checkWatches

var NewCheckWatches = newCheckWatches

func (c *checkWatches) Open(ctx context.Context, id string) *CheckWatch {
	return c.open(ctx, Deps{}, id)
}
func (c *checkWatches) Close(id string, w *CheckWatch) { c.close(id, w) }
func (c *checkWatches) Find(id string) *CheckWatch     { return c.find(id) }
