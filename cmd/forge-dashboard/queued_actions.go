package main

import (
	"context"
	"errors"
	"log/slog"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// queuedUsersLister names who still has a queued action waiting.
type queuedUsersLister interface {
	UsersWithWaitingQueuedActions(ctx context.Context) ([][]byte, error)
}

// credentialsGetter reads one user's saved settings.
type credentialsGetter interface {
	Get(ctx context.Context, userID []byte) (settings.Credentials, error)
}

// dashboardStarter starts a user's dashboard unless it is already running.
type dashboardStarter interface {
	EnsureIfAbsent(ctx context.Context, userID []byte, sources []dashboard.Source)
}

// resumeQueuedActions starts the dashboard of every user with a queued action
// still waiting (#756). A queued action runs from its user's dashboard, and a
// restart leaves none running until that user next signs in, which may be
// after the reset the action was waiting for. Starting them here keeps the
// promise that a queued action survives a restart and still runs at the reset.
// A failure is logged and starts nothing: the action stays stored, and runs
// once the user's dashboard starts some other way.
func resumeQueuedActions(ctx context.Context, users queuedUsersLister, creds credentialsGetter, build func([]byte, settings.Credentials) []dashboard.Source, starter dashboardStarter) {
	ids, err := users.UsersWithWaitingQueuedActions(ctx)
	if err != nil {
		slog.Warn("could not list users with queued actions", "error", err)

		return
	}
	for _, id := range ids {
		c, err := creds.Get(ctx, id)
		if err != nil {
			if !errors.Is(err, settings.ErrNotFound) {
				slog.Warn("could not load settings to resume queued actions", "error", err)
			}

			continue
		}
		starter.EnsureIfAbsent(ctx, id, build(id, c))
	}
}
