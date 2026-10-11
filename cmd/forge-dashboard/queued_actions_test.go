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

type fakeQueuedUsers struct {
	users [][]byte
	err   error
}

func (f fakeQueuedUsers) UsersWithWaitingQueuedActions(context.Context) ([][]byte, error) {
	return f.users, f.err
}

type fakeCredentials map[string]settings.Credentials

func (f fakeCredentials) Get(_ context.Context, userID []byte) (settings.Credentials, error) {
	c, ok := f[string(userID)]
	if !ok {
		return settings.Credentials{}, settings.ErrNotFound
	}

	return c, nil
}

type recordingEnsurer struct{ ensured [][]byte }

func (r *recordingEnsurer) EnsureIfAbsent(_ context.Context, userID []byte, _ []dashboard.Source) {
	r.ensured = append(r.ensured, userID)
}

func buildNothing([]byte, settings.Credentials) []dashboard.Source { return nil }

// A restart wipes every running dashboard, and a queued action only runs from
// one, so the server starts the dashboard of each user who still has one waiting.
func TestResumeQueuedActions_StartsTheDashboardOfEachUserWithAWaitingAction(t *testing.T) {
	ensurer := &recordingEnsurer{}
	users := fakeQueuedUsers{users: [][]byte{[]byte("a"), []byte("b")}}
	creds := fakeCredentials{"a": {GitHubToken: "x"}, "b": {GitHubToken: "y"}}

	resumeQueuedActions(t.Context(), users, creds, buildNothing, ensurer)

	assert.Equal(t, [][]byte{[]byte("a"), []byte("b")}, ensurer.ensured)
}

func TestResumeQueuedActions_UserWithNoSavedSettings_IsSkipped(t *testing.T) {
	ensurer := &recordingEnsurer{}
	users := fakeQueuedUsers{users: [][]byte{[]byte("gone"), []byte("a")}}
	creds := fakeCredentials{"a": {GitHubToken: "x"}}

	resumeQueuedActions(t.Context(), users, creds, buildNothing, ensurer)

	assert.Equal(t, [][]byte{[]byte("a")}, ensurer.ensured)
}

func TestResumeQueuedActions_StoreFailure_StartsNothingAndDoesNotPanic(t *testing.T) {
	ensurer := &recordingEnsurer{}

	require.NotPanics(t, func() {
		resumeQueuedActions(t.Context(), fakeQueuedUsers{err: errors.New("db down")}, fakeCredentials{}, buildNothing, ensurer)
	})

	assert.Empty(t, ensurer.ensured)
}
