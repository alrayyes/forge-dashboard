package forgejo

import (
	"context"
	"sync"

	"code.gitea.io/sdk/gitea"
)

// jobPagesMemo holds the pages of jobs read while one pull request row is
// resolved, so the two questions the row asks of a run (was a failure
// cancelled, which pending job is running) cost one request between them.
// It lives as long as that resolution and no longer, so it never serves an old
// read to a later poll.
type jobPagesMemo struct {
	mu    sync.Mutex
	pages map[jobPageKey]jobPage
}

type jobPageKey struct {
	runID int64
	page  int
}

type jobPage struct {
	jobs  []*gitea.ActionWorkflowJob
	total int
}

type jobPagesMemoKey struct{}

// withJobPagesMemo returns a context whose job page reads are shared.
func withJobPagesMemo(ctx context.Context) context.Context {
	return context.WithValue(ctx, jobPagesMemoKey{}, &jobPagesMemo{pages: map[jobPageKey]jobPage{}})
}

// memoFrom is the memo of ctx, or nil when it has none.
func memoFrom(ctx context.Context) *jobPagesMemo {
	memo, _ := ctx.Value(jobPagesMemoKey{}).(*jobPagesMemo)

	return memo
}

func (m *jobPagesMemo) get(key jobPageKey) (jobPage, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	page, ok := m.pages[key]

	return page, ok
}

func (m *jobPagesMemo) put(key jobPageKey, page jobPage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pages[key] = page
}
