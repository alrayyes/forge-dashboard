package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// SetupResponse matches components.schemas.SetupResponse. It states facts and
// leaves the steps, and which one is current, to the page.
type SetupResponse struct {
	GitHub    SetupGitHub  `json:"github"`
	Forgejo   SetupForgejo `json:"forgejo"`
	Refreshed bool         `json:"refreshed"`
}

// SetupGitHub matches components.schemas.SetupGitHub.
type SetupGitHub struct {
	Configured               bool                `json:"configured"`
	InstallURL               string              `json:"installUrl"`
	Authorized               bool                `json:"authorized"`
	Account                  string              `json:"account"`
	Installations            []SetupInstallation `json:"installations"`
	InstallationsUnavailable bool                `json:"installationsUnavailable"`
	RepositoryCount          int                 `json:"repositoryCount"`
}

// SetupInstallation matches components.schemas.SetupInstallation.
type SetupInstallation struct {
	ID           int64  `json:"id"`
	AccountLogin string `json:"accountLogin"`
	Saved        bool   `json:"saved"`
}

// SetupForgejo matches components.schemas.SetupForgejo.
type SetupForgejo struct {
	RedirectURI     string   `json:"redirectUri"`
	Scopes          []string `json:"scopes"`
	InstanceURL     string   `json:"instanceUrl"`
	Linked          bool     `json:"linked"`
	Account         string   `json:"account"`
	RepositoryCount int      `json:"repositoryCount"`
	Reachable       bool     `json:"reachable"`
}

// handleSetupGet answers GET /api/v1/setup, what the first-login page needs to
// show where each forge stands.
func handleSetupGet(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		resp, err := buildSetup(r.Context(), deps)
		if err != nil {
			slog.Warn("setup: could not read the link state")
			writeJSON(w, http.StatusInternalServerError, errorBody("could not read the setup state"))

			return
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// verifyForgejoInstanceRequest matches components.schemas.VerifyForgejoInstanceRequest.
type verifyForgejoInstanceRequest struct {
	InstanceURL string `json:"instanceUrl"`
}

// ForgejoInstanceCheck matches components.schemas.ForgejoInstanceCheck.
type ForgejoInstanceCheck struct {
	InstanceURL string `json:"instanceUrl"`
}

// handleSetupVerifyInstance answers POST /api/v1/setup/forgejo-instance. The
// page calls it before it shows the owner what to register, so a mistyped
// address is caught while they can still fix it.
func handleSetupVerifyInstance() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		var req verifyForgejoInstanceRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("request body must be JSON with an instanceUrl"))

			return
		}

		raw := strings.TrimSpace(req.InstanceURL)
		if raw == "" || len(raw) > maxInstanceURLLen {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("instanceUrl", "instanceUrl must be the address of your Forgejo"))

			return
		}

		if msg := forgejoURLProblem("instanceUrl", raw); msg != "" {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("instanceUrl", msg))

			return
		}

		instance, err := oauth.CheckForgejoInstance(r.Context(), raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("instanceUrl", "nothing at that address answered like a Forgejo"))

			return
		}

		writeJSON(w, http.StatusOK, ForgejoInstanceCheck{InstanceURL: instance})
	}
}

func buildSetup(ctx context.Context, deps Deps) (SetupResponse, error) {
	creds, err := deps.SettingsStore.Get(ctx)
	if err != nil && !errors.Is(err, settings.ErrNotFound) {
		return SetupResponse{}, fmt.Errorf("read settings: %w", err)
	}

	forgejoLinked, err := deps.SettingsStore.HasOAuthToken(ctx, forgejoForge)
	if err != nil {
		return SetupResponse{}, fmt.Errorf("read forgejo link: %w", err)
	}

	snap := dashboard.Snapshot{}
	refreshed := false

	if deps.Service != nil {
		snap, refreshed = deps.Service.Get(), deps.Service.FirstRefreshDone()
		// A forge still on its first read has no counts to give yet.
		refreshed = refreshed && !slices.ContainsFunc(snap.Forges, dashboard.ForgeHealth.NeverRead)
	}

	gh, err := setupGitHub(ctx, deps, snap)
	if err != nil {
		return SetupResponse{}, err
	}

	fj := SetupForgejo{
		RedirectURI: deps.PublicOrigin + "/api/v1/connections/forgejo/callback",
		Scopes:      oauth.ForgejoScopes(),
		Reachable:   true,
	}
	if forgejoLinked {
		fj.Linked, fj.Account, fj.InstanceURL = true, creds.ForgejoUsername, publicForgejoURL(creds.ForgejoURL)
	}

	if h, ok := healthOf(snap, dashboard.ForgeForgejo); ok {
		fj.RepositoryCount, fj.Reachable = h.RepoCount, h.Reachable
	}

	return SetupResponse{GitHub: gh, Forgejo: fj, Refreshed: refreshed}, nil
}

func setupGitHub(ctx context.Context, deps Deps, snap dashboard.Snapshot) (SetupGitHub, error) {
	gh := SetupGitHub{
		Configured:    deps.GitHubOAuth.Configured(),
		Installations: []SetupInstallation{},
	}

	if deps.GitHubAppSlug != "" {
		gh.InstallURL = (&url.URL{Scheme: "https", Host: "github.com", Path: "/apps/" + deps.GitHubAppSlug + "/installations/new"}).String()
	}

	if h, ok := healthOf(snap, dashboard.ForgeGitHub); ok {
		gh.RepositoryCount = h.RepoCount
	}

	authorized, err := deps.SettingsStore.HasOAuthToken(ctx, githubForge)
	if err != nil {
		return gh, fmt.Errorf("read github link: %w", err)
	}

	if !authorized || !gh.Configured {
		return gh, nil
	}

	gh.Authorized = true

	if account, err := deps.GitHubOAuth.Account(ctx); err == nil {
		gh.Account = account
	}

	listed, err := deps.GitHubOAuth.UserInstallations(ctx)
	if err != nil {
		slog.Warn("setup: could not list the user's installations")

		gh.InstallationsUnavailable = true

		return gh, nil
	}

	stored, err := deps.SettingsStore.Installations(ctx)
	if err != nil {
		return gh, fmt.Errorf("read installations: %w", err)
	}

	saved := map[int64]bool{}
	for _, in := range stored {
		saved[in.ID] = true
	}

	for _, in := range listed {
		gh.Installations = append(gh.Installations, SetupInstallation{ID: in.ID, AccountLogin: in.AccountLogin, Saved: saved[in.ID]})
	}

	return gh, nil
}

func healthOf(snap dashboard.Snapshot, forge dashboard.Forge) (dashboard.ForgeHealth, bool) {
	for _, h := range snap.Forges {
		if h.Forge == forge {
			return h, true
		}
	}

	return dashboard.ForgeHealth{}, false
}
