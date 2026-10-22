package main

import (
	"context"
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeQueue struct {
	waiting bool
	err     error
}

func (f fakeQueue) HasWaitingQueuedActions(context.Context) (bool, error) { return f.waiting, f.err }

type fakeCredentials struct {
	creds settings.Credentials
	err   error
}

func (f fakeCredentials) Get(context.Context) (settings.Credentials, error) { return f.creds, f.err }

type recordingEnsurer struct{ started int }

func (r *recordingEnsurer) EnsureIfAbsent(context.Context, []dashboard.Source) { r.started++ }

func buildNothing(settings.Credentials) []dashboard.Source { return nil }

// A restart wipes the running dashboard, and a queued action only runs from
// it, so the server starts the dashboard when one is still waiting.
func TestResumeQueuedActions_AWaitingAction_StartsTheDashboard(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{waiting: true},
		fakeCredentials{creds: settings.Credentials{GitHubToken: "x"}}, buildNothing, ensurer)

	assert.Equal(t, 1, ensurer.started)
}

func TestResumeQueuedActions_NothingWaiting_StartsNothing(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{}, fakeCredentials{}, buildNothing, ensurer)

	assert.Zero(t, ensurer.started)
}

func TestResumeQueuedActions_NoSavedSettings_StartsNothing(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{waiting: true},
		fakeCredentials{err: settings.ErrNotFound}, buildNothing, ensurer)

	assert.Zero(t, ensurer.started)
}

func TestResumeQueuedActions_StoreFailure_StartsNothingAndDoesNotPanic(t *testing.T) {
	ensurer := &recordingEnsurer{}

	require.NotPanics(t, func() {
		resumeQueuedActions(t.Context(), fakeQueue{err: errors.New("db down")}, fakeCredentials{}, buildNothing, ensurer)
	})

	assert.Zero(t, ensurer.started)
}
