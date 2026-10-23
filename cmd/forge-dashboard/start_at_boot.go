package main

import (
	"context"
	"errors"
	"log/slog"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// credentialsGetter reads the saved settings.
type credentialsGetter interface {
	Get(ctx context.Context) (settings.Credentials, error)
}

// dashboardStarter starts the dashboard unless it is already running.
type dashboardStarter interface {
	StartAtBoot(ctx context.Context, sources []dashboard.Source)
}

// startDashboardAtBoot starts the first refresh from the saved settings as the
// process starts, so it is usually done by the time the deploy finishes and the
// owner signs in. It also keeps a queued action alive across a restart: one only
// runs from the dashboard, which a restart wipes.
//
// The saved credentials are the one owner's, kept for the whole app and not for
// a session, so using them with nobody signed in grants nothing new: they are
// the same ones a sign-in would start with. A failure is logged and starts
// nothing: the dashboard then starts on the next sign-in or settings save.
func startDashboardAtBoot(ctx context.Context, creds credentialsGetter, build func(settings.Credentials) []dashboard.Source, starter dashboardStarter) {
	c, err := creds.Get(ctx)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load settings to start the dashboard", "error", err)
		}

		return
	}
	starter.StartAtBoot(ctx, build(c))
}
