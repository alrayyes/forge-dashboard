package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// repoStatus is one tracked repo plus whether this app has ever recorded
// a signature-verified webhook delivery for it, and in which scope(s), if
// any, the signed-in user has ignored it (#363, #511) — both
// settings.Store's own concern, folded in here rather than on
// dashboard.Snapshot itself, since the dashboard package has no reason to
// know settings exists (see the issue this shipped against for why a live
// forge API check isn't used instead).
type repoStatus struct {
	Forge             dashboard.Forge `json:"forge"`
	FullName          string          `json:"fullName"`
	URL               string          `json:"url"`
	HasWebhook        bool            `json:"hasWebhook"`
	CanManageWebhooks bool            `json:"canManageWebhooks"`
	Ignored           bool            `json:"ignored"`
	IgnoredPRs        bool            `json:"ignoredPRs"`
	IgnoredIssues     bool            `json:"ignoredIssues"`
	AutoUpdateBranch  bool            `json:"autoUpdateBranch"`
}

// dashboardResponse is the wire shape for /api/dashboard and its SSE
// stream: dashboard.Snapshot's own fields, with Repos replaced by the
// richer repoStatus shape above.
type dashboardResponse struct {
	GeneratedAt  time.Time               `json:"generatedAt"`
	Forges       []dashboard.ForgeHealth `json:"forges"`
	PullRequests []dashboard.PullRequest `json:"pullRequests"`
	Issues       []dashboard.Issue       `json:"issues"`
	Repos        []repoStatus            `json:"repos"`
}

// buildDashboardResponse merges snap's tracked-repo list with userID's
// recorded webhook deliveries and ignored repos. HasWebhook is an OR of
// two signals: r's own live check (dashboard.WebhookChecker, against the
// forge's actual webhook list — see #238) and the delivery table below,
// so a repo whose live check errored or whose Source has no webhook path
// configured still reports true once a real delivery has ever arrived. A
// store failure degrades to the live signal alone (webhook coverage) or
// to "nothing ignored" (repo filtering) rather than failing the whole
// dashboard — the same "one broken piece doesn't take down the rest"
// resilience the rest of this package already applies to a single
// unreachable forge.
//
// An ignored repo (#363) is deliberately not excluded from Repos itself
// — only from PullRequests/Issues — so it still appears on the Webhooks
// page with accurate coverage status and can still be un-ignored; see
// the issue's own "reversible, not destructive" design decision.
func buildDashboardResponse(ctx context.Context, store *settings.Store, userID []byte, snap dashboard.Snapshot) dashboardResponse {
	deliveries, err := store.WebhookDeliveries(ctx, userID)
	if err != nil {
		slog.Warn("could not load webhook deliveries for dashboard response", "error", err)
		deliveries = nil
	}
	ignored, err := store.IgnoredRepos(ctx, userID)
	if err != nil {
		slog.Warn("could not load ignored repos for dashboard response", "error", err)
		ignored = nil
	}
	autoUpdateBranch, err := store.AutoUpdateBranchRepos(ctx, userID)
	if err != nil {
		slog.Warn("could not load auto-update-branch repos for dashboard response", "error", err)
		autoUpdateBranch = nil
	}

	repos := make([]repoStatus, 0, len(snap.Repos))
	for _, r := range snap.Repos {
		hasWebhook := r.HasWebhook
		if !hasWebhook {
			_, hasWebhook = deliveries[settings.WebhookDeliveryKey(string(r.Forge), r.FullName)]
		}
		scope := ignored[settings.WebhookDeliveryKey(string(r.Forge), r.FullName)]
		_, autoUpdate := autoUpdateBranch[settings.WebhookDeliveryKey(string(r.Forge), r.FullName)]
		repos = append(repos, repoStatus{
			Forge:             r.Forge,
			FullName:          r.FullName,
			URL:               r.URL,
			HasWebhook:        hasWebhook,
			CanManageWebhooks: r.CanManageWebhooks,
			Ignored:           scope.PRs || scope.Issues,
			IgnoredPRs:        scope.PRs,
			IgnoredIssues:     scope.Issues,
			AutoUpdateBranch:  autoUpdate,
		})
	}

	pullRequests := make([]dashboard.PullRequest, 0, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		if !ignored[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)].PRs {
			pullRequests = append(pullRequests, pr)
		}
	}
	issues := make([]dashboard.Issue, 0, len(snap.Issues))
	for _, issue := range snap.Issues {
		if !ignored[settings.WebhookDeliveryKey(string(issue.Forge), issue.Repo)].Issues {
			issues = append(issues, issue)
		}
	}

	return dashboardResponse{
		GeneratedAt:  snap.GeneratedAt,
		Forges:       snap.Forges,
		PullRequests: pullRequests,
		Issues:       issues,
		Repos:        repos,
	}
}

// errDashboardOwnerNotFound and errDashboardNotShared are
// resolveDashboardFor's own sentinel errors — every caller (the HTTP
// handler below, and the MCP get_dashboard tool) maps them to its own
// transport's "not found"/"forbidden" shape, rather than resolveDashboardFor
// knowing HTTP status codes or MCP error content itself.
var (
	errDashboardOwnerNotFound = errors.New("no user is registered under that username")
	errDashboardNotShared     = errors.New("that user hasn't shared their dashboard with you")
)

// resolveDashboardFor returns the dashboard data ownerUsername's account
// currently has — requester's own by default (ownerUsername empty or
// equal to requester's own username), or another user's once that user
// has shared their dashboard with requester (dashboard.SharingStore).
// Shared by handleDashboard and the MCP get_dashboard tool (mcp.go) so the
// ownership/sharing rule only lives in one place. Never blocks on either
// forge: Manager.Get reads whatever that user's background refresh last
// assembled — empty, not an error, for a user who hasn't saved any
// credentials in Settings yet.
func resolveDashboardFor(ctx context.Context, deps Deps, requester *auth.User, ownerUsername string) (dashboardResponse, error) {
	if ownerUsername == "" || ownerUsername == requester.Username {
		warmUpAggregator(ctx, deps, requester.ID, requester.Username)

		return buildDashboardResponse(ctx, deps.SettingsStore, requester.ID, deps.Manager.Get(requester.ID)), nil
	}

	owner, err := deps.AuthStore.GetUserByUsername(ctx, ownerUsername)
	if err != nil {
		if errors.Is(err, auth.ErrNotFound) {
			return dashboardResponse{}, errDashboardOwnerNotFound
		}

		return dashboardResponse{}, fmt.Errorf("look up owner: %w", err)
	}

	shared, err := deps.SharingStore.IsSharedWith(ctx, owner.ID, requester.ID)
	if err != nil {
		return dashboardResponse{}, fmt.Errorf("check sharing: %w", err)
	}
	if !shared {
		return dashboardResponse{}, errDashboardNotShared
	}

	warmUpAggregator(ctx, deps, owner.ID, owner.Username)

	return buildDashboardResponse(ctx, deps.SettingsStore, owner.ID, deps.Manager.Get(owner.ID)), nil
}

// handleDashboard answers the requested dashboard: the signed-in user's
// own by default, or another user's — passed as ?owner=username — when
// that user has shared their dashboard with the caller.
func handleDashboard(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			// RequireAuth always sets this before handleDashboard runs;
			// reaching here with none would be a wiring bug, not a
			// request this handler can meaningfully answer.
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		resp, err := resolveDashboardFor(r.Context(), deps, u, r.URL.Query().Get("owner"))
		if err != nil {
			switch {
			case errors.Is(err, errDashboardOwnerNotFound):
				writeJSON(w, http.StatusNotFound, errorBody(err.Error()))
			case errors.Is(err, errDashboardNotShared):
				writeJSON(w, http.StatusForbidden, errorBody(err.Error()))
			default:
				writeJSON(w, http.StatusInternalServerError, errorBody(err.Error()))
			}

			return
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// warmUpAggregator re-establishes userID's Aggregator from whatever they
// last saved in Settings, if the Manager doesn't already have one
// running for them. The Manager holds no state across a process restart
// — every deploy wipes it — and a request against an already-valid
// session cookie never goes through startSession's own warm-up again the
// way a fresh login does, so without this a dashboard that survived a
// restart would show the zero-value empty snapshot forever, not just
// until the next scheduled refresh. A user with nothing saved yet is a
// no-op, same as Manager.Get's empty-snapshot default.
//
// The Running() check is a fast path — cheap, and safe even if it races,
// since a false negative just falls through to EnsureIfAbsent below,
// which is what actually has to be race-safe: several requests for the
// same user landing in the same instant right after a restart (several
// browser tabs and an SSE reconnect, all reconnecting at once) used to
// each see "not running" from a bare Running() check and each spin up
// their own Aggregator with its own immediate Refresh — confirmed as a
// real, if not fully explained, contributor to a request-volume burst
// live in production.
func warmUpAggregator(ctx context.Context, deps Deps, userID []byte, username string) {
	if deps.Manager.Running(userID) {
		return
	}
	creds, err := deps.SettingsStore.Get(ctx, userID)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load settings to warm up dashboard", "user", username, "error", err)
		}

		return
	}
	deps.Manager.EnsureIfAbsent(deps.AppContext, userID, deps.BuildSources(userID, creds))
}

// loadAndEnsure loads userID's saved Settings and (re)builds their
// Aggregator from them — unconditionally, unlike warmUpAggregator, since
// startSession calls this on every login regardless of whether one's
// already running, to pick up whatever was most recently saved.
func loadAndEnsure(ctx context.Context, deps Deps, userID []byte, username string) {
	creds, err := deps.SettingsStore.Get(ctx, userID)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load settings to warm up dashboard", "user", username, "error", err)
		}

		return
	}
	deps.Manager.Ensure(deps.AppContext, userID, deps.BuildSources(userID, creds))
}

// handleDashboardRefresh triggers an immediate, out-of-band refresh of
// the signed-in user's own dashboard and blocks until it completes,
// returning the resulting snapshot — for retrying right away after a
// forge was only briefly unreachable, instead of waiting out the rest of
// the scheduled REFRESH_INTERVAL.
//
// Like handleDashboardStream, and unlike handleDashboard: no ?owner=,
// only ever the signed-in user's own dashboard, so a user with shared
// access to someone else's dashboard can never spend that owner's own
// forge rate-limit budget on their own schedule.
//
// Passes deps.AppContext to RefreshNow, not r.Context(): coalescer.do
// only threads the *first* caller's context into the shared fetch — every
// later caller that arrives while a run is already in flight just waits
// on that same run. Using the request's own context here would mean a
// closed browser tab could cancel a refresh the scheduled ticker, or
// another tab's own force-refresh click, is depending on.
func handleDashboardRefresh(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		if !deps.Manager.RefreshNow(deps.AppContext, u.ID) {
			// No Aggregator running yet (Settings has never been saved) —
			// the same condition and message handleDashboardStream uses.
			writeJSON(w, http.StatusNotFound, errorBody("no background refresh is running yet for this user"))

			return
		}
		writeJSON(w, http.StatusOK, buildDashboardResponse(r.Context(), deps.SettingsStore, u.ID, deps.Manager.Get(u.ID)))
	}
}

// handleDashboardStream pushes the signed-in user's own dashboard
// snapshot over Server-Sent Events every time their Aggregator produces
// a new one — most notably right after a verified webhook delivery
// triggers Manager.RefreshNow, which is what turns that into a live
// update instead of something only the next scheduled refresh picks up.
//
// Unlike handleDashboard, there's no ?owner= — only ever the signed-in
// user's own dashboard. The frontend's own poll against GET
// /api/dashboard keeps running unconditionally, connected or not: a
// browser or proxy that can't hold this connection open just never
// benefits from it, rather than the dashboard going stale silently.
func handleDashboardStream(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("streaming not supported"))

			return
		}

		warmUpAggregator(r.Context(), deps, u.ID, u.Username)

		ch, unsubscribe, ok := deps.Manager.Subscribe(u.ID)
		if !ok {
			// No Aggregator running yet (Settings has never been saved) —
			// a plain 404 rather than an open connection with nothing to
			// send. EventSource retries a failed connection on its own,
			// so the browser picks the stream up once one exists.
			writeJSON(w, http.StatusNotFound, errorBody("no background refresh is running yet for this user"))

			return
		}
		defer unsubscribe()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		for {
			select {
			case <-r.Context().Done():
				return
			case snap, open := <-ch:
				if !open {
					return
				}
				data, err := json.Marshal(buildDashboardResponse(r.Context(), deps.SettingsStore, u.ID, snap))
				if err != nil {
					return
				}
				if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}
