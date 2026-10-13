package github_test

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
)

// warningCounter counts the "required checks unreadable" warnings, which are
// logged through the default logger.
type warningCounter struct {
	mu sync.Mutex
	n  int
}

func (w *warningCounter) Enabled(context.Context, slog.Level) bool { return true }

func (w *warningCounter) Handle(_ context.Context, r slog.Record) error {
	if r.Level == slog.LevelWarn && strings.Contains(r.Message, "required checks unreadable") {
		w.mu.Lock()
		w.n++
		w.mu.Unlock()
	}

	return nil
}

func (w *warningCounter) WithAttrs([]slog.Attr) slog.Handler { return w }
func (w *warningCounter) WithGroup(string) slog.Handler      { return w }

func (w *warningCounter) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()

	return w.n
}

// watchWarnings replaces the default logger for one test. These tests are not
// parallel, because the default logger is shared by everything in the process.
func watchWarnings(t *testing.T) *warningCounter {
	t.Helper()

	counter := &warningCounter{}
	previous := slog.Default()
	slog.SetDefault(slog.New(counter))
	t.Cleanup(func() { slog.SetDefault(previous) })

	return counter
}

// A repo whose branch protection can't be read stays unreadable poll after
// poll, so it warns once and not once a cache period (#1387).
func TestFetch_UnreadableRequiredChecks_WarnOncePerRepo(t *testing.T) {
	warnings := watchWarnings(t)
	srvData := &partialRequiredServer{protection: []string{"check"}, rulesets: []string{"check"}, pages: [][]string{{"check"}}}
	srvData.protectionFails.Store(true)
	srv := srvData.start(t)
	client := github.NewClient("test-token", "", srv.URL)

	for range 4 {
		client.Fetch(t.Context())
		client.ExpirePartialRequiredContexts()
	}

	assert.Equal(t, 1, warnings.count())
}

// Once it can be read, the next failure is news again.
func TestFetch_RequiredChecksUnreadableAgain_WarnsAgain(t *testing.T) {
	warnings := watchWarnings(t)
	// "lint" is required and hasn't reported, so the commit is never remembered
	// as complete and every poll looks the required checks up again.
	srvData := &partialRequiredServer{protection: []string{"check", "lint"}, rulesets: []string{"check"}, pages: [][]string{{"check"}}}
	srvData.protectionFails.Store(true)
	srv := srvData.start(t)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	client.ExpireRequiredContexts()
	srvData.protectionFails.Store(false)
	client.Fetch(t.Context())
	assert.Equal(t, 1, warnings.count(), "readable again: no new warning")

	client.ExpireRequiredContexts()
	srvData.protectionFails.Store(true)
	client.Fetch(t.Context())

	assert.Equal(t, 2, warnings.count())
}

// A repo that is readable and requires nothing is normal and says nothing.
func TestFetch_ReadableRepoRequiringNothing_DoesNotWarn(t *testing.T) {
	warnings := watchWarnings(t)
	srvData := &partialRequiredServer{protection: []string{}, rulesets: []string{}, pages: [][]string{{}}}
	srv := srvData.start(t)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	client.Fetch(t.Context())

	assert.Zero(t, warnings.count())
}

// A branch with no protection rule answers a 404, which is an answer: nothing is
// required, so there is nothing to warn about.
func TestFetch_UnprotectedBranch_DoesNotWarn(t *testing.T) {
	warnings := watchWarnings(t)
	srvData := &partialRequiredServer{protection: []string{}, rulesets: []string{}, pages: [][]string{{}}}
	srvData.protectionMissing.Store(true)
	srv := srvData.start(t)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	client.ExpireRequiredContexts()
	client.Fetch(t.Context())

	assert.Zero(t, warnings.count())
}
