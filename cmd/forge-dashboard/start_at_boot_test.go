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

type fakeCredentials struct {
	creds settings.Credentials
	err   error
}

func (f fakeCredentials) Get(context.Context) (settings.Credentials, error) { return f.creds, f.err }

type recordingStarter struct{ started int }

func (r *recordingStarter) StartAtBoot(context.Context, []dashboard.Source) { r.started++ }

func buildNothing(settings.Credentials) []dashboard.Source { return nil }

// A restart wipes the running dashboard, and nothing refreshes it until
// someone asks. The saved settings belong to the one owner, so the process
// starts from them itself and the first refresh runs while the deploy settles.
func TestStartDashboardAtBoot_SavedSettings_StartsTheDashboard(t *testing.T) {
	starter := &recordingStarter{}

	startDashboardAtBoot(t.Context(), fakeCredentials{creds: settings.Credentials{GitHubToken: "x"}}, buildNothing, starter)

	assert.Equal(t, 1, starter.started)
}

func TestStartDashboardAtBoot_NoSavedSettings_StartsNothing(t *testing.T) {
	starter := &recordingStarter{}

	startDashboardAtBoot(t.Context(), fakeCredentials{err: settings.ErrNotFound}, buildNothing, starter)

	assert.Zero(t, starter.started)
}

func TestStartDashboardAtBoot_StoreFailure_StartsNothingAndDoesNotPanic(t *testing.T) {
	starter := &recordingStarter{}

	require.NotPanics(t, func() {
		startDashboardAtBoot(t.Context(), fakeCredentials{err: errors.New("db down")}, buildNothing, starter)
	})

	assert.Zero(t, starter.started)
}
