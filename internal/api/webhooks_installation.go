package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// userInstallationLister is what the gate on a `created` delivery needs from
// the linked GitHub account: the installations GitHub lists for it.
type userInstallationLister interface {
	UserInstallations(ctx context.Context) ([]oauth.UserInstallation, error)
}

// installationHandler keeps the stored installation list in step with the
// App's installation and installation_repositories webhooks (#4587).
type installationHandler struct {
	store        *settings.Store
	service      *dashboard.Service
	buildSources func(settings.Credentials) []dashboard.Source
	// lister is nil when no GitHub account can be linked on this deployment.
	lister userInstallationLister
}

func newInstallationHandler(deps Deps) *installationHandler {
	h := &installationHandler{store: deps.SettingsStore, service: deps.Service, buildSources: deps.BuildSources}
	if deps.GitHubOAuth != nil {
		h.lister = deps.GitHubOAuth
	}

	return h
}

// installationEvent is the part of an installation or installation_repositories
// delivery the dashboard reads: what happened, and to which installation.
type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
}

// wants says whether a verified delivery is one this handler takes: a GitHub
// installation event. A nil handler, as the Forgejo route has, takes nothing.
func (h *installationHandler) wants(forge dashboard.Forge, event string) bool {
	return h != nil && forge == dashboard.ForgeGitHub &&
		(event == "installation" || event == "installation_repositories")
}

// respond applies a verified delivery and writes the answer: 204, or 500 when a
// redelivery could fix the failure.
func (h *installationHandler) respond(ctx context.Context, w http.ResponseWriter, forge dashboard.Forge, event, delivery string, body []byte) {
	slog.Info("webhook accepted", "forge", forge, "event", event, "delivery", delivery)
	if err := h.apply(ctx, event, body); err != nil {
		slog.Warn("installation webhook failed", "event", event, "delivery", delivery, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody("could not update the installation list"))

		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// apply acts on a verified delivery. It returns an error only for a failure a
// redelivery could fix (the store or GitHub's list did not answer), so the
// caller answers 500; a malformed body, an installation the dashboard doesn't
// know and an action it doesn't act on are all fine and return nil.
//
//   - created is stored only when GitHub lists the installation for the linked
//     account, the check the Setup URL flow makes. The App's webhook fires for
//     every installation of the App, so without it anyone's install would reach
//     the board. An installation that is not listed, or with no linked account,
//     is ignored, as is one already stored (a replay must not reset it). A
//     replay of created after deleted is ignored too, because GitHub no longer
//     lists the installation.
//   - deleted, suspend and unsuspend change a stored row only.
//   - installation_repositories refreshes the board for a stored installation.
func (h *installationHandler) apply(ctx context.Context, event string, body []byte) error {
	var ev installationEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.Installation.ID <= 0 {
		return nil
	}
	id := ev.Installation.ID

	known, err := h.knows(ctx, id)
	if err != nil {
		return err
	}

	if event == "installation_repositories" {
		if known {
			go h.service.RefreshNow(ctx)
		}

		return nil
	}

	changed, err := h.change(ctx, ev.Action, id, known)
	if err != nil || !changed {
		return err
	}

	return h.rebuild(ctx)
}

// change applies an installation action to the store. It reports whether a row
// changed, so a delivery that needs nothing doesn't rebuild the sources.
func (h *installationHandler) change(ctx context.Context, action string, id int64, known bool) (bool, error) {
	switch {
	case action == "created" && !known:
		err := h.storeCreated(ctx, id)
		if errors.Is(err, errNotOurs) {
			return false, nil
		}

		return err == nil, err
	case action == "deleted" && known:
		if err := h.store.RemoveInstallation(ctx, id); err != nil {
			return false, fmt.Errorf("remove installation: %w", err)
		}

		return true, nil
	case (action == "suspend" || action == "unsuspend") && known:
		if err := h.store.SetInstallationSuspended(ctx, id, action == "suspend"); err != nil {
			return false, fmt.Errorf("set installation suspended: %w", err)
		}

		return true, nil
	default:
		return false, nil
	}
}

func (h *installationHandler) knows(ctx context.Context, id int64) (bool, error) {
	rows, err := h.store.Installations(ctx)
	if err != nil {
		return false, fmt.Errorf("list installations: %w", err)
	}
	for _, in := range rows {
		if in.ID == id {
			return true, nil
		}
	}

	return false, nil
}

// errNotOurs marks a created delivery the dashboard leaves alone.
var errNotOurs = errors.New("installation not listed for the linked account")

// storeCreated adds an installation GitHub lists for the linked account, with
// the account name GitHub gives, not the one in the delivery.
func (h *installationHandler) storeCreated(ctx context.Context, id int64) error {
	if h.lister == nil {
		return errNotOurs
	}
	listed, err := h.lister.UserInstallations(ctx)
	if errors.Is(err, oauth.ErrNotConnected) {
		return errNotOurs
	}
	if err != nil {
		return fmt.Errorf("list the linked account's installations: %w", err)
	}
	login, found := installationLogin(listed, id)
	if !found {
		return errNotOurs
	}

	if err := h.store.SaveInstallation(ctx, settings.Installation{ID: id, AccountLogin: login}); err != nil {
		return fmt.Errorf("save installation: %w", err)
	}

	return nil
}

// rebuild replaces the dashboard's sources from the saved settings, under the
// service's own lock. It does so even when no source is left, so a removed or
// suspended last installation stops being read. With no dashboard running there
// is nothing to replace.
func (h *installationHandler) rebuild(ctx context.Context) error {
	if !h.service.Running() {
		return nil
	}

	var loadErr error
	h.service.EnsureFrom(ctx, func() ([]dashboard.Source, bool) {
		creds, err := h.store.Get(ctx)
		if err != nil {
			loadErr = fmt.Errorf("read the saved settings: %w", err)

			return nil, false
		}

		return h.buildSources(creds), true
	})

	return loadErr
}
