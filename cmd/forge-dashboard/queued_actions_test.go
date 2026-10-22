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

type fakeOwner struct {
	id  []byte
	err error
}

func (f fakeOwner) OwnerID(context.Context) ([]byte, error) { return f.id, f.err }

type fakeCredentials struct {
	creds settings.Credentials
	err   error
}

func (f fakeCredentials) Get(context.Context) (settings.Credentials, error) { return f.creds, f.err }

type recordingEnsurer struct{ ensured [][]byte }

func (r *recordingEnsurer) EnsureIfAbsent(_ context.Context, userID []byte, _ []dashboard.Source) {
	r.ensured = append(r.ensured, userID)
}

func buildNothing([]byte, settings.Credentials) []dashboard.Source { return nil }

// A restart wipes the running dashboard, and a queued action only runs from
// it, so the server starts the dashboard when one is still waiting.
func TestResumeQueuedActions_AWaitingAction_StartsTheOwnersDashboard(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{waiting: true}, fakeOwner{id: []byte("a")},
		fakeCredentials{creds: settings.Credentials{GitHubToken: "x"}}, buildNothing, ensurer)

	assert.Equal(t, [][]byte{[]byte("a")}, ensurer.ensured)
}

func TestResumeQueuedActions_NothingWaiting_StartsNothing(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{}, fakeOwner{id: []byte("a")}, fakeCredentials{}, buildNothing, ensurer)

	assert.Empty(t, ensurer.ensured)
}

func TestResumeQueuedActions_NoSavedSettings_StartsNothing(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{waiting: true}, fakeOwner{id: []byte("a")},
		fakeCredentials{err: settings.ErrNotFound}, buildNothing, ensurer)

	assert.Empty(t, ensurer.ensured)
}

func TestResumeQueuedActions_NoOwner_StartsNothing(t *testing.T) {
	ensurer := &recordingEnsurer{}

	resumeQueuedActions(t.Context(), fakeQueue{waiting: true}, fakeOwner{err: errors.New("none")}, fakeCredentials{}, buildNothing, ensurer)

	assert.Empty(t, ensurer.ensured)
}

func TestResumeQueuedActions_StoreFailure_StartsNothingAndDoesNotPanic(t *testing.T) {
	ensurer := &recordingEnsurer{}

	require.NotPanics(t, func() {
		resumeQueuedActions(t.Context(), fakeQueue{err: errors.New("db down")}, fakeOwner{}, fakeCredentials{}, buildNothing, ensurer)
	})

	assert.Empty(t, ensurer.ensured)
}
