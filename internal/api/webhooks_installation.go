package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// installationEvent is the part of an installation or installation_repositories
// delivery the dashboard reads: what happened, and to which installation.
type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	} `json:"installation"`
}

// isInstallationEvent says whether a GitHub event name describes a change to the
// App's installations rather than to a repository.
func isInstallationEvent(event string) bool {
	return event == "installation" || event == "installation_repositories"
}

// wantsInstallationUpdate says whether a verified delivery is one the
// installation list handles: a GitHub installation event, on a handler wired
// with a way to rebuild the sources.
func wantsInstallationUpdate(forge dashboard.Forge, event string, buildSources func(settings.Credentials) []dashboard.Source) bool {
	return forge == dashboard.ForgeGitHub && isInstallationEvent(event) && buildSources != nil
}

// applyInstallationDelivery keeps the stored installation list in step with a
// verified installation or installation_repositories delivery (#4587). A
// created, deleted, suspend or unsuspend action adds, removes or marks the row
// and rebuilds the dashboard's sources so reads follow the list. A change to an
// installation's repositories reads them again, for an installation the
// dashboard knows. Any other action, and any installation the dashboard does
// not know, is ignored.
func applyInstallationDelivery(ctx context.Context, store *settings.Store, service *dashboard.Service, buildSources func(settings.Credentials) []dashboard.Source, event string, body []byte) {
	var ev installationEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.Installation.ID <= 0 {
		return
	}
	id := ev.Installation.ID

	if event == "installation_repositories" {
		known, err := store.Installations(ctx)
		if err != nil || !slices.ContainsFunc(known, func(in settings.Installation) bool { return in.ID == id }) {
			return
		}
		go service.RefreshNow(ctx)

		return
	}

	var err error
	switch ev.Action {
	case "created":
		err = store.SaveInstallation(ctx, settings.Installation{ID: id, AccountLogin: ev.Installation.Account.Login})
	case "deleted":
		err = store.RemoveInstallation(ctx, id)
	case "suspend":
		err = store.SetInstallationSuspended(ctx, id, true)
	case "unsuspend":
		err = store.SetInstallationSuspended(ctx, id, false)
	default:
		return
	}
	if err != nil {
		slog.Warn("installation webhook: could not update the installation list", "action", ev.Action, "error", err)

		return
	}

	creds, err := store.Get(ctx)
	if err != nil {
		slog.Warn("installation webhook: could not read the saved settings", "error", err)

		return
	}
	if sources := buildSources(creds); len(sources) > 0 {
		service.Ensure(ctx, sources)
	}
}
