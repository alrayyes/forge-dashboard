package main

import (
	"context"
	"errors"
	"log/slog"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// queuedWaiter says whether any queued action still waits.
type queuedWaiter interface {
	HasWaitingQueuedActions(ctx context.Context) (bool, error)
}

// credentialsGetter reads the saved settings.
type credentialsGetter interface {
	Get(ctx context.Context) (settings.Credentials, error)
}

// dashboardStarter starts the dashboard unless it is already running.
type dashboardStarter interface {
	EnsureIfAbsent(ctx context.Context, sources []dashboard.Source)
}

// resumeQueuedActions starts the dashboard when a queued action still waits
// (#756). A queued action runs from the dashboard, and a restart leaves none
// running until the user next signs in, which may be after the reset the action
// was waiting for. Starting it here keeps the promise that a queued action
// survives a restart and still runs at the reset. A failure is logged and
// starts nothing: the action stays stored, and runs once the dashboard starts
// some other way.
func resumeQueuedActions(ctx context.Context, queue queuedWaiter, creds credentialsGetter, build func(settings.Credentials) []dashboard.Source, starter dashboardStarter) {
	waiting, err := queue.HasWaitingQueuedActions(ctx)
	if err != nil {
		slog.Warn("could not look for queued actions", "error", err)

		return
	}
	if !waiting {
		return
	}
	c, err := creds.Get(ctx)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load settings to resume queued actions", "error", err)
		}

		return
	}
	starter.EnsureIfAbsent(ctx, build(c))
}
