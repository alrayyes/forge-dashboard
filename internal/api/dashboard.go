package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strconv"
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
	PullRequests []pullRequestView       `json:"pullRequests"`
	Issues       []issueView             `json:"issues"`
	// OpenIssueCount is how many of Issues are real work, without the
	// housekeeping ones (#980).
	OpenIssueCount int          `json:"openIssueCount"`
	Repos          []repoStatus `json:"repos"`
	// HiddenDrafts is how many draft pull requests PullRequests leaves out
	// (#791). Always serialized, and zero when the request included drafts.
	HiddenDrafts int `json:"hiddenDrafts"`
	// AutoMerged is what this app merged for the user in the last few
	// minutes, so the page can say so once the pull request has left.
	AutoMerged []autoMergedView `json:"autoMerged"`
	// ReadIntervalSeconds is how often a client should re-read the dashboard
	// (#809). Always the same answer for now; it lives in the response so a
	// client keeps no interval of its own.
	ReadIntervalSeconds int `json:"readIntervalSeconds"`
}

// clientReadInterval is what the API advises clients to re-read the
// dashboard at. A read serves the cached snapshot and never calls a forge, so
// this is not the backend's REFRESH_INTERVAL.
const clientReadInterval = 30 * time.Second

// issueView is an issue as the API serves it: the snapshot's own fields plus
// whether it is a bot's housekeeping issue, decided here so every client
// agrees (#980).
type issueView struct {
	dashboard.Issue
	Housekeeping bool `json:"housekeeping"`
}

// pullRequestView is a pull request as the API serves it: the snapshot's own
// fields plus the actions it allows, worked out here so every client gets
// the same answer (#805). The snapshot type stays free of it.
type pullRequestView struct {
	dashboard.PullRequest
	// Kind is what sort of pull request this is, so a client needs no rule of
	// its own for release and dependency pull requests (#716).
	Kind           dashboard.PullRequestKind      `json:"kind"`
	AllowedActions []dashboard.ActionAvailability `json:"allowedActions"`
	// ReadyToMerge and NeedsReview are the Ready and Needs review quick
	// filters' answers (#807), so a second client lists the same pull
	// requests the page does.
	ReadyToMerge bool `json:"readyToMerge"`
	NeedsReview  bool `json:"needsReview"`
	// ReviewRequestedFromMe is true when this open, non-draft pull request
	// asks the signed-in user to review it (#695), by the username saved in
	// Settings for its forge. False when no username is saved.
	ReviewRequestedFromMe bool `json:"reviewRequestedFromMe"`
	// AutoMerge says why an armed pull request is waiting or stopped. Absent
	// when auto-merge isn't armed on it.
	AutoMerge *dashboard.AutoMergeStatus `json:"autoMerge,omitempty"`
}

// autoMergedView matches components.schemas.AutoMergedPullRequest.
type autoMergedView struct {
	Forge    dashboard.Forge `json:"forge"`
	FullName string          `json:"fullName"`
	Number   int             `json:"number"`
	MergedAt time.Time       `json:"mergedAt"`
	Message  string          `json:"message"`
}

// autoMerged lists the report's recent merges, newest first, as the message
// the page shows. Never nil: the contract promises an array.
func (b boardSettings) autoMerged() []autoMergedView {
	out := make([]autoMergedView, 0, len(b.autoMergeReport.Merged))
	for _, m := range b.autoMergeReport.Merged {
		out = append(out, autoMergedView{
			Forge: m.Forge, FullName: m.Repo, Number: m.Number, MergedAt: m.At,
			Message: "Auto-merged " + m.Repo + "#" + strconv.Itoa(m.Number) + " after checks passed",
		})
	}

	return out
}

// autoMergeStatus explains pr when the user armed auto-merge on it, nil
// otherwise.
func (b boardSettings) autoMergeStatus(pr dashboard.PullRequest) *dashboard.AutoMergeStatus {
	if pr.AutoMergeEnabled == nil || !*pr.AutoMergeEnabled || pr.Forge != dashboard.ForgeForgejo {
		return nil
	}
	var failure *dashboard.AutoMergeFailure
	if f, ok := b.autoMergeReport.Failures[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; ok {
		failure = &f
	}
	status := dashboard.AutoMergeStatusOf(pr, failure)

	return &status
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
//
// Draft pull requests (#791) are left out unless includeDrafts, since nothing
// can be merged or updated on one, and are counted in HiddenDrafts instead.
// Ignored repos filter first, so HiddenDrafts counts only drafts in repos
// whose other pull requests would show.
func buildDashboardResponse(ctx context.Context, deps Deps, userID []byte, snap dashboard.Snapshot, includeDrafts bool) dashboardResponse {
	board := loadBoardSettings(ctx, deps.SettingsStore, userID)
	board.autoMergeReport = deps.Manager.AutoMergeReport(userID)
	pullRequests, hiddenDrafts := board.pullRequestViews(snap.PullRequests, includeDrafts)
	issues, openIssues := board.issueViews(snap.Issues)

	return dashboardResponse{
		GeneratedAt:    snap.GeneratedAt,
		Forges:         withRateLimitSeverity(snap.Forges, time.Now()),
		PullRequests:   pullRequests,
		Issues:         issues,
		OpenIssueCount: openIssues,
		Repos:          board.repoStatuses(snap.Repos),
		HiddenDrafts:   hiddenDrafts,
		AutoMerged:     board.autoMerged(),

		ReadIntervalSeconds: int(clientReadInterval / time.Second),
	}
}

// boardSettings is what the response is built with besides the snapshot: the
// user's own state for each repo, and their login on each forge.
type boardSettings struct {
	deliveries       map[string]struct{}
	ignored          map[string]settings.IgnoreScope
	autoUpdateBranch map[string]struct{}
	autoMerge        map[string]struct{}
	autoMergeReport  dashboard.AutoMergeReport
	logins           map[dashboard.Forge]string
	// renovateAuthors are the logins the user says are Renovate (#1062).
	renovateAuthors []string
}

// loadBoardSettings reads boardSettings. Each store failure degrades that one
// piece, to no delivery signal, nothing ignored, auto-update off or no login,
// and never fails the response.
func loadBoardSettings(ctx context.Context, store *settings.Store, userID []byte) boardSettings {
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

	autoMerge, err := store.AutoMergeIntents(ctx, userID)
	if err != nil {
		slog.Warn("could not load auto-merge intents for dashboard response", "error", err)
		autoMerge = nil
	}

	// The signed-in user's own login on each forge, from Settings. A store
	// failure degrades to "no login", so nothing is marked as requested.
	logins := map[dashboard.Forge]string{}
	var renovateAuthors []string
	if creds, err := store.Get(ctx, userID); err == nil {
		renovateAuthors = creds.RenovateAuthors
		logins[dashboard.ForgeGitHub] = creds.GitHubUsername
		logins[dashboard.ForgeForgejo] = creds.ForgejoUsername
	}

	return boardSettings{deliveries: deliveries, ignored: ignored, autoUpdateBranch: autoUpdateBranch, autoMerge: autoMerge, logins: logins, renovateAuthors: renovateAuthors}
}

// repoStatuses is the tracked-repo list with each repo's webhook coverage and
// the user's ignore and auto-update choices.
func (b boardSettings) repoStatuses(repos []dashboard.Repo) []repoStatus {
	out := make([]repoStatus, 0, len(repos))
	for _, r := range repos {
		key := settings.WebhookDeliveryKey(string(r.Forge), r.FullName)
		hasWebhook := r.HasWebhook
		if !hasWebhook {
			_, hasWebhook = b.deliveries[key]
		}
		scope := b.ignored[key]
		_, autoUpdate := b.autoUpdateBranch[key]
		out = append(out, repoStatus{
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

	return out
}

// pullRequestViews leaves out the pull requests of ignored repos, then the
// drafts unless includeDrafts, and says how many drafts that hid.
func (b boardSettings) pullRequestViews(prs []dashboard.PullRequest, includeDrafts bool) ([]pullRequestView, int) {
	out := make([]pullRequestView, 0, len(prs))
	hiddenDrafts := 0
	for _, pr := range prs {
		if b.ignored[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)].PRs {
			continue
		}
		if pr.Draft && !includeDrafts {
			hiddenDrafts++

			continue
		}
		pr = withAutoMergeIntent(pr, b.autoMerge)
		out = append(out, pullRequestView{
			PullRequest:    pr,
			Kind:           dashboard.KindOf(pr, b.renovateAuthors),
			AllowedActions: b.allowedActions(pr),
			ReadyToMerge:   dashboard.IsReadyToMerge(pr),
			NeedsReview:    dashboard.NeedsReview(pr),

			ReviewRequestedFromMe: dashboard.ReviewRequestedFrom(pr, b.logins[pr.Forge]),
			AutoMerge:             b.autoMergeStatus(pr),
		})
	}

	return out, hiddenDrafts
}

// allowedActions is the pull request's actions, minus an offer to update its
// branch where the repo updates branches itself (#1080): the app is about to
// do it. A blocked entry stays, since auto-update can't resolve a conflict and
// the user needs to hear about it.
func (b boardSettings) allowedActions(pr dashboard.PullRequest) []dashboard.ActionAvailability {
	actions := dashboard.AllowedActions(pr, b.renovateAuthors)
	if _, auto := b.autoUpdateBranch[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)]; !auto {
		return actions
	}

	return slices.DeleteFunc(actions, func(a dashboard.ActionAvailability) bool {
		return a.Action == dashboard.ActionUpdateBranch && a.Blocked == nil
	})
}

// issueViews leaves out the issues of ignored repos and counts the ones that
// are real work.
func (b boardSettings) issueViews(issues []dashboard.Issue) ([]issueView, int) {
	out := make([]issueView, 0, len(issues))
	open := 0
	for _, issue := range issues {
		if b.ignored[settings.WebhookDeliveryKey(string(issue.Forge), issue.Repo)].Issues {
			continue
		}
		housekeeping := dashboard.IsHousekeepingIssue(issue)
		out = append(out, issueView{Issue: issue, Housekeeping: housekeeping})
		if !housekeeping {
			open++
		}
	}

	return out, open
}

// wantsDrafts reads includeDrafts from the query. Only "true" opts in, so a
// missing or malformed value gets the default: drafts left out (#791).
func wantsDrafts(r *http.Request) bool {
	return r.URL.Query().Get("includeDrafts") == "true"
}

// withRateLimitSeverity returns forges with each rate-limit budget graded as
// of now (#806). The snapshot's own ForgeHealth is left as it is: severity is
// worked out per response, from the clock, so it never goes stale in one.
func withRateLimitSeverity(forges []dashboard.ForgeHealth, now time.Time) []dashboard.ForgeHealth {
	graded := func(rl *dashboard.RateLimit) *dashboard.RateLimit {
		if rl == nil {
			return nil
		}
		copied := *rl
		copied.Severity = copied.SeverityAt(now)

		return &copied
	}

	out := make([]dashboard.ForgeHealth, len(forges))
	for i, f := range forges {
		f.RateLimitGraphQL = graded(f.RateLimitGraphQL)
		f.RateLimitREST = graded(f.RateLimitREST)
		out[i] = f
	}

	return out
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
func resolveDashboardFor(ctx context.Context, deps Deps, requester *auth.User, ownerUsername string, includeDrafts bool) (dashboardResponse, error) {
	if ownerUsername == "" || ownerUsername == requester.Username {
		warmUpAggregator(ctx, deps, requester.ID, requester.Username)

		return buildDashboardResponse(ctx, deps, requester.ID, deps.Manager.Get(requester.ID), includeDrafts), nil
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

	return buildDashboardResponse(ctx, deps, owner.ID, deps.Manager.Get(owner.ID), includeDrafts), nil
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

		resp, err := resolveDashboardFor(r.Context(), deps, u, r.URL.Query().Get("owner"), wantsDrafts(r))
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
// the scheduled REFRESH_INTERVAL. A call inside the per-user cooldown
// (Manager.ForceRefresh) skips the fetch and says so with Retry-After.
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

		retryAfter, running := deps.Manager.ForceRefresh(deps.AppContext, u.ID)
		if !running {
			// No Aggregator running yet (Settings has never been saved) —
			// the same condition and message handleDashboardStream uses.
			writeJSON(w, http.StatusNotFound, errorBody("no background refresh is running yet for this user"))

			return
		}
		if retryAfter > 0 {
			// Inside the cooldown: no fetch, the current snapshot and the
			// wait. Not a 429 -- the page calls this after every action, and
			// a refusal would leave the row stale (#809).
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter.Seconds()))))
		}
		writeJSON(w, http.StatusOK, buildDashboardResponse(r.Context(), deps, u.ID, deps.Manager.Get(u.ID), wantsDrafts(r)))
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

		// Read once: every event on this connection follows the choice it
		// opened with, and a client that changes its mind reconnects.
		includeDrafts := wantsDrafts(r)

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		streamSnapshots(r.Context(), w, flusher, ch, func(snap dashboard.Snapshot) dashboardResponse {
			return buildDashboardResponse(r.Context(), deps, u.ID, snap, includeDrafts)
		})
	}
}

// streamSnapshots writes one server-sent event for each snapshot that arrives
// on ch, until the client goes away, ch closes, or a write fails.
func streamSnapshots(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, ch <-chan dashboard.Snapshot, render func(dashboard.Snapshot) dashboardResponse) {
	for {
		select {
		case <-ctx.Done():
			return
		case snap, open := <-ch:
			if !open {
				return
			}
			data, err := json.Marshal(render(snap))
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
