// Package requestlog persists a queryable record of every outbound
// request forge-dashboard makes to GitHub or Forgejo (#482), so a
// rate-limit or connectivity incident can be debugged from what
// actually happened on the wire instead of from stdout logs alone.
// internal/github and internal/forgejo each depend on this package's
// Recorder — the one interface both clients need identically, so it
// lives here rather than being duplicated per client, the same way
// internal/dashboard already holds RateLimiter/RepoRefresher for the
// equivalent shared-dependency shape.
package requestlog

import (
	"context"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// MaxEntries is the row-count retention cap SQLiteRecorder enforces on
// every write — trimmed on insert rather than swept on a schedule, so
// storage never grows past this regardless of how bursty traffic gets.
const MaxEntries = 10000

// OutcomeSuccess is Entry.Outcome's value for a request that completed
// successfully. Any other value is a dashboard.ForgeErrorKind string.
const OutcomeSuccess = "success"

// Entry is one outbound request's own record.
type Entry struct {
	ID        int64
	LoggedAt  time.Time
	Forge     dashboard.Forge
	AccountID string // "" when no per-account credential made this request
	Method    string
	Endpoint  string
	// StatusCode is 0 when the request never got a response at all.
	StatusCode int
	// Outcome is OutcomeSuccess or a dashboard.ForgeErrorKind string.
	Outcome string
	// RateLimitLimit/RateLimitRemaining/RateLimitResetsAt/RateLimitCost
	// are all nil when the response carried no rate-limit fields —
	// not every request reports these.
	RateLimitLimit     *int
	RateLimitRemaining *int
	RateLimitResetsAt  *time.Time
	RateLimitCost      *int
}

// Filter narrows a listing to entries matching every set field — a zero
// Filter (both fields empty) matches everything.
type Filter struct {
	Forge     dashboard.Forge
	AccountID string
}

// Recorder is what internal/github and internal/forgejo depend on to
// persist an Entry for every outbound request they make. A Record error
// never changes the outbound request's own result — see NoopRecorder
// and each client's own call site, which logs it via slog.Warn and
// otherwise ignores it: logging a request is diagnostic, not part of
// what the request itself promises to do.
type Recorder interface {
	Record(ctx context.Context, e Entry) error
}

// NoopRecorder discards every Entry — what a forge client falls back to
// when constructed with no Recorder at all, so every existing caller
// and test keeps compiling and passing unchanged.
type NoopRecorder struct{}

// Record implements Recorder by doing nothing.
func (NoopRecorder) Record(context.Context, Entry) error { return nil }

var _ Recorder = NoopRecorder{}
