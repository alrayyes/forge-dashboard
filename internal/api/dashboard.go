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
	LogoURL           string          `json:"logoUrl,omitempty"`
	HasWebhook        bool            `json:"hasWebhook"`
	CanManageWebhooks bool            `json:"canManageWebhooks"`
	Ignored           bool            `json:"ignored"`
	IgnoredPRs        bool            `json:"ignoredPRs"`
	IgnoredIssues     bool            `json:"ignoredIssues"`
	AutoUpdateBranch  bool            `json:"autoUpdateBranch"`

	// WebhookLockedByConnection: the credential, not the user's role, is
	// why CanManageWebhooks is false (see dashboard.Repo).
	WebhookLockedByConnection bool `json:"webhookLockedByConnection,omitempty"`
	// WebhookNeedsToken: no credential is saved, so CanManageWebhooks is
	// false for lack of a token, not of a role (see dashboard.Repo).
	WebhookNeedsToken bool `json:"webhookNeedsToken,omitempty"`
}

// dashboardResponse is the wire shape for /api/dashboard and its SSE
// stream: dashboard.Snapshot's own fields, with Repos replaced by the
// richer repoStatus shape above.
type dashboardResponse struct {
	GeneratedAt  time.Time               `json:"generatedAt"`
	Forges       []dashboard.ForgeHealth `json:"forges"`
	PullRequests []pullRequestView       `json:"pullRequests"`
	Issues       []issueView             `json:"issues"`
	// FirstRefreshDone is true once there is something to show for this viewer:
	// their first refresh since the process started has finished (succeeded or
	// failed), or the snapshot already lists a forge, for instance one warmed
	// from the saved cache. It is false only while the page has nothing to
	// show, so it shows a loading state, not an empty board. Always serialized.
	FirstRefreshDone bool `json:"firstRefreshDone"`
	// OpenIssueCount is how many of Issues are real work, without the
	// housekeeping ones (#980). Issues already leaves out what the viewer's
	// own settings hide (#1630), so this follows them.
	OpenIssueCount int `json:"openIssueCount"`
	// SettingsHiddenIssueCount is how many open issues the viewer's own
	// settings left out of Issues (#1630). Always serialized, zero when none.
	SettingsHiddenIssueCount int `json:"settingsHiddenIssueCount"`
	// HideDependencyDashboard and IgnoredTitlesSet mirror the viewer's own
	// settings (#1630), always, so a client knows whether to draw its two
	// fields without reading GET /api/settings. IgnoredTitlesSet is true when
	// the list is not empty, whether or not a pattern matches anything.
	HideDependencyDashboard bool `json:"hideDependencyDashboard"`
	IgnoredTitlesSet        bool `json:"ignoredTitlesSet"`
	// NavCounts is each nav badge's total and failed number (#1315), counted
	// from the lists above so they always agree with the pages.
	NavCounts navCounts    `json:"navCounts"`
	Repos     []repoStatus `json:"repos"`
	// HiddenDrafts is how many draft pull requests PullRequests leaves out
	// (#791). Always serialized, and zero when the request included drafts.
	HiddenDrafts int `json:"hiddenDrafts"`
	// HiddenPullRequests is how many pull requests the user hid that are still
	// open and not expired (#841). Always serialized. With includeHidden they
	// are in PullRequests, marked hidden, and still counted here.
	HiddenPullRequests int `json:"hiddenPullRequests"`
	// AutoMerged is what this app merged for the user in the last few
	// minutes, so the page can say so once the pull request has left.
	AutoMerged []autoMergedView `json:"autoMerged"`
	// QueuedActions is the signed-in user's own queue, waiting and finished
	// (#756).
	QueuedActions []dashboard.QueuedAction `json:"queuedActions"`
	// ReadIntervalSeconds is how often a client should re-read the dashboard
	// (#809). It lives in the response so a client keeps no interval of its
	// own. It is short until the first refresh since the process started has
	// finished, so the page picks fresh data up soon after it is ready, and
	// the normal one from then on. It follows that real state, not the
	// serialized FirstRefreshDone, which is also true for a snapshot restored
	// from the saved cache.
	ReadIntervalSeconds int `json:"readIntervalSeconds"`
}

// clientReadInterval is what the API advises clients to re-read the
// dashboard at. A read serves the cached snapshot and never calls a forge, so
// this is not the backend's REFRESH_INTERVAL.
const clientReadInterval = 30 * time.Second

// firstLoadReadInterval is the advice while a viewer's first refresh has not
// finished: the page is showing a loading state, and a read held for
// firstLoadWait can come back empty. Waiting the full clientReadInterval then
// leaves the data unseen for half a minute after it is ready.
const firstLoadReadInterval = 2 * time.Second

// readInterval is the re-read advice for a response whose flag is done. It
// takes the flag the builder already computed, so the two cannot disagree.
func readInterval(done bool) time.Duration {
	if done {
		return clientReadInterval
	}

	return firstLoadReadInterval
}

// firstLoadWait is how long a read waits for an Aggregator's first refresh
// before answering with whatever the snapshot holds. A fresh process or a
// settings save leaves the snapshot empty until then, and an empty answer
// reads as "no pull requests" (#1194). Past it a slow forge shows its
// ForgeHealth rather than keeping the page waiting.
const firstLoadWait = 15 * time.Second

// firstLoadWait is how long a read waits for the first refresh: Deps.FirstLoadWait
// when set, else the default. Only a test sets it.
func (d Deps) firstLoadWait() time.Duration {
	if d.FirstLoadWait > 0 {
		return d.FirstLoadWait
	}

	return firstLoadWait
}

// issueView is an issue as the API serves it: the snapshot's own fields plus
// whether it is a bot's housekeeping issue, decided here so every client
// agrees (#980).
type issueView struct {
	dashboard.Issue
	Housekeeping bool `json:"housekeeping"`
	// AuthorURL is the author's profile page on the forge, built here so no
	// client needs a rule per forge. Empty for a deleted account.
	AuthorURL string `json:"authorUrl"`
	// LinkedPullRequests are the open pull requests that will close this
	// issue, joined here from the snapshot's own pull requests.
	LinkedPullRequests []linkedPullRequest `json:"linkedPullRequests"`
}

// linkedPullRequest is one pull request that will close an issue, with the
// address on this dashboard that opens its pop-up.
type linkedPullRequest struct {
	Forge   dashboard.Forge `json:"forge"`
	Repo    string          `json:"repo"`
	Number  int             `json:"number"`
	Draft   bool            `json:"draft"`
	PageURL string          `json:"pageUrl"`
	// CI, Checks and AwaitingWorkflowApproval are the pull request's own
	// pipeline fields, passed through so a pill can draw the same status as
	// the pull request's row.
	CI                       dashboard.CIStatus    `json:"ci"`
	Checks                   dashboard.CheckCounts `json:"checks"`
	AwaitingWorkflowApproval bool                  `json:"awaitingWorkflowApproval"`
}

// pullRequestPage is the dashboard page that lists a pull request of kind.
func pullRequestPage(kind dashboard.PullRequestKind) string {
	switch kind {
	case dashboard.KindRelease:
		return "/releases.html"
	case dashboard.KindDependency:
		return "/bots.html"
	default:
		return "/pull-requests.html"
	}
}

// linkedPullRequests lists the pull requests that close issue, each with the
// address that opens it. Never nil.
func (b boardSettings) linkedPullRequests(index dashboard.ClosingIndex, issue dashboard.Issue) []linkedPullRequest {
	prs := index.For(issue)
	out := make([]linkedPullRequest, 0, len(prs))
	for _, pr := range prs {
		out = append(out, linkedPullRequest{
			Forge:  pr.Forge,
			Repo:   pr.Repo,
			Number: pr.Number,
			Draft:  pr.Draft,
			CI:     pr.CI,
			Checks: pr.Checks,

			AwaitingWorkflowApproval: pr.AwaitingWorkflowApproval,
			PageURL:                  pullRequestPage(dashboard.KindOf(pr, b.renovateAuthors)) + "?pr=" + string(pr.Forge) + "/" + pr.Repo + "/" + strconv.Itoa(pr.Number),
		})
	}

	return out
}

// closingIssue is one issue a pull request will close, with the address on
// this dashboard that opens the Issues page on its pop-up.
type closingIssue struct {
	dashboard.IssueRef
	PageURL string `json:"pageUrl"`
}

// closingIssues adds the address to each of pr's closing references. Never nil.
func closingIssues(pr dashboard.PullRequest) []closingIssue {
	out := make([]closingIssue, 0, len(pr.ClosesIssues))
	for _, ref := range pr.ClosesIssues {
		out = append(out, closingIssue{
			IssueRef: ref,
			PageURL:  "/issues.html?issue=" + string(pr.Forge) + "/" + ref.Repo + "/" + strconv.Itoa(ref.Number),
		})
	}

	return out
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
	// ClosesIssues shadows the snapshot's list to add the address on this
	// dashboard that opens each issue.
	ClosesIssues []closingIssue `json:"closesIssues"`
	// AuthorURL is the author's profile page on the forge, built here so no
	// client needs a rule per forge. Empty for a deleted account.
	AuthorURL string `json:"authorUrl"`
	// Status is what the pull request is waiting on or blocked by, for one
	// fixed place on a row (#1375). Null when nothing holds it back.
	Status *dashboard.Status `json:"status"`
	// ReadyToMerge and NeedsReview are the Ready and Needs review quick
	// filters' answers (#807), so a second client lists the same pull
	// requests the page does.
	ReadyToMerge bool `json:"readyToMerge"`
	NeedsReview  bool `json:"needsReview"`
	// FailingCI is the Failing CI filter's answer and the rule behind the menu
	// pill's Failed number (#1946): CI is failing and not only because a
	// workflow run is held for approval.
	FailingCI bool `json:"failingCi"`
	// ReviewRequestedFromMe is true when this open, non-draft pull request
	// asks the signed-in user to review it (#695), by the username saved in
	// Settings for its forge. False when no username is saved.
	ReviewRequestedFromMe bool `json:"reviewRequestedFromMe"`
	// AutoMerge says why an armed pull request is waiting or stopped. Absent
	// when auto-merge isn't armed on it.
	AutoMerge *dashboard.AutoMergeStatus `json:"autoMerge,omitempty"`
	// AutoUpdate says whether the dashboard brings this pull request's branch
	// up to date by itself, from its own choice or its repo's setting, and
	// why a switch would do nothing for it.
	AutoUpdate dashboard.AutoUpdate `json:"autoUpdate"`
	// Queued is the safe action this user queued on the pull request that is
	// still waiting for the rate limit to reset, or null (#756).
	Queued *dashboard.QueuedAction `json:"queued"`
	// Hidden marks a pull request the user hid, in a response that asked for
	// them with includeHidden (#841). Without that they aren't listed at all.
	Hidden bool `json:"hidden,omitempty"`
	// HiddenUntil is when a timed hide ends. Absent for one that lasts until
	// the user restores it.
	HiddenUntil *time.Time `json:"hiddenUntil,omitempty"`
}

// queuedActions is the user's queue, never nil: the contract promises an array.
func (b boardSettings) queuedActions() []dashboard.QueuedAction {
	if b.queued == nil {
		return []dashboard.QueuedAction{}
	}

	return b.queued
}

// waitingQueuedAction is the action still waiting for the reset on pr, or nil.
func (b boardSettings) waitingQueuedAction(pr dashboard.PullRequest) *dashboard.QueuedAction {
	for _, q := range b.queued {
		if q.Status == dashboard.QueuedWaiting && q.Forge == pr.Forge && q.Repo == pr.Repo && q.Number == pr.Number {
			return &q
		}
	}

	return nil
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

// autoMergeStatus explains pr when the user armed auto-merge on it, or when
// the app has just cancelled it for them; nil otherwise.
func (b boardSettings) autoMergeStatus(pr dashboard.PullRequest) *dashboard.AutoMergeStatus {
	if pr.AutoMergeEnabled == nil || !*pr.AutoMergeEnabled {
		// Not armed now. If the app just cancelled it because the pull request
		// went empty, say so for a few minutes, so the row doesn't go quiet
		// without a reason (#1375).
		if c, ok := b.autoMergeReport.Cancelled[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; ok {
			return &dashboard.AutoMergeStatus{State: dashboard.AutoMergeStopped, Code: c.Refusal.Code, Message: c.Refusal.Message}
		}

		return nil
	}
	var failure *dashboard.AutoMergeFailure
	if f, ok := b.autoMergeReport.Failures[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; ok {
		failure = &f
	}
	status := dashboard.AutoMergeStatusOf(pr, failure)

	return &status
}

// boardView is what a request asks the board to include besides what it
// shows by default: drafts (#791) and the pull requests the user hid (#841).
type boardView struct {
	includeDrafts bool
	includeHidden bool
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
//
// A pull request the user hid (#841) is left out unless view.includeHidden,
// and counted in HiddenPullRequests. Hides come before drafts, so a hidden
// draft is only in the hidden count.
func buildDashboardResponse(ctx context.Context, deps Deps, userID []byte, snap dashboard.Snapshot, view boardView) dashboardResponse {
	board := loadBoardSettings(ctx, deps.SettingsStore, userID)
	board.autoMergeReport = deps.Manager.AutoMergeReport(userID)
	board.forgetClosedHides(ctx, deps.SettingsStore, userID, snap)
	pullRequests, hiddenDrafts, hiddenPullRequests := board.pullRequestViews(snap.PullRequests, view)
	filter := loadIssueFilter(ctx, deps.SettingsStore, userID)
	issues, openIssues, settingsHidden := board.issueViews(snap.Issues, snap.PullRequests, filter)

	done := firstRefreshDone(deps.Manager, userID)
	// A snapshot with forges in it was either refreshed or restored from the
	// last run, and either way there is something to show instead of a
	// loading state. The short read interval still follows the real flag.
	shown := done || len(snap.Forges) > 0

	return dashboardResponse{
		GeneratedAt:    snap.GeneratedAt,
		Forges:         withRateLimitSeverity(snap.Forges, time.Now()),
		PullRequests:   pullRequests,
		Issues:         issues,
		OpenIssueCount: openIssues,

		FirstRefreshDone: shown,

		SettingsHiddenIssueCount: settingsHidden,
		HideDependencyDashboard:  filter.hideHousekeeping,
		IgnoredTitlesSet:         filter.titlesSet,
		NavCounts:                buildNavCounts(pullRequests, openIssues, board.mainBranchRows(snap.MainBranches)),
		Repos:                    board.repoStatuses(snap.Repos),
		HiddenDrafts:             hiddenDrafts,

		HiddenPullRequests: hiddenPullRequests,
		AutoMerged:         board.autoMerged(),
		QueuedActions:      board.queuedActions(),

		ReadIntervalSeconds: int(readInterval(done) / time.Second),
	}
}

// firstRefreshDone is the snapshot's flag for userID. A user with no
// Aggregator after warmUpAggregator has no saved settings, so nothing will
// ever refresh for them and nothing is loading: report true, or a page waiting
// on the flag would show its skeleton forever. Ensuring an empty Aggregator
// instead would change the stream and refresh endpoints, which answer 404
// while none runs.
func firstRefreshDone(m *dashboard.Manager, userID []byte) bool {
	return m.FirstRefreshDone(userID) || !m.Running(userID)
}

// boardSettings is what the response is built with besides the snapshot: the
// user's own state for each repo, and their login on each forge.
type boardSettings struct {
	deliveries       map[string]struct{}
	ignored          map[string]settings.IgnoreScope
	autoUpdateBranch map[string]struct{}
	// autoUpdateChoices are the pull requests with their own choice about
	// automatic branch updates, keyed by settings.AutoMergeKey.
	autoUpdateChoices map[string]bool
	autoMerge         map[string]struct{}
	autoMergeReport   dashboard.AutoMergeReport
	queued            []dashboard.QueuedAction
	// hidden are the pull requests the user hid, keyed by settings.AutoMergeKey (#841).
	hidden map[string]settings.HiddenPullRequest
	logins map[dashboard.Forge]string
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

	autoUpdateChoices, err := store.PullRequestAutoUpdates(ctx, userID)
	if err != nil {
		slog.Warn("could not load pull request auto-update choices for dashboard response", "error", err)
		autoUpdateChoices = nil
	}

	queued, err := store.QueuedActions(ctx, userID)
	if err != nil {
		slog.Warn("could not load queued actions for dashboard response", "error", err)
		queued = nil
	}

	autoMerge, err := store.AutoMergeIntents(ctx, userID)
	if err != nil {
		slog.Warn("could not load auto-merge intents for dashboard response", "error", err)
		autoMerge = nil
	}

	hidden, err := store.HiddenPullRequests(ctx, userID, time.Now())
	if err != nil {
		slog.Warn("could not load hidden pull requests for dashboard response", "error", err)
		hidden = nil
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

	return boardSettings{deliveries: deliveries, ignored: ignored, autoUpdateBranch: autoUpdateBranch, autoUpdateChoices: autoUpdateChoices, autoMerge: autoMerge, queued: queued, hidden: hidden, logins: logins, renovateAuthors: renovateAuthors}
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
			LogoURL:           r.LogoURL,
			HasWebhook:        hasWebhook,
			CanManageWebhooks: r.CanManageWebhooks,
			Ignored:           scope.PRs || scope.Issues,
			IgnoredPRs:        scope.PRs,
			IgnoredIssues:     scope.Issues,
			AutoUpdateBranch:  autoUpdate,

			WebhookLockedByConnection: r.WebhookLockedByConnection,
			WebhookNeedsToken:         r.WebhookNeedsToken,
		})
	}

	return out
}

// pullRequestViews leaves out the pull requests of ignored repos, then the ones
// the user hid unless view.includeHidden, then the drafts unless
// view.includeDrafts. It says how many it hid of each of the last two.
func (b boardSettings) pullRequestViews(prs []dashboard.PullRequest, view boardView) (views []pullRequestView, hiddenDrafts, hiddenPullRequests int) {
	out := make([]pullRequestView, 0, len(prs))
	for _, pr := range prs {
		if b.ignored[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)].PRs {
			continue
		}
		hide, isHidden := b.hidden[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]
		if isHidden {
			hiddenPullRequests++
			if !view.includeHidden {
				continue
			}
		}
		if pr.Draft && !view.includeDrafts && !isHidden {
			hiddenDrafts++

			continue
		}
		pr = withAutoMergeIntent(pr, b.autoMerge)
		actions := b.allowedActions(pr)
		item := pullRequestView{
			PullRequest:    pr,
			AuthorURL:      dashboard.ProfileURL(pr.Forge, dashboard.WebBase(pr.URL, pr.Repo), pr.Author),
			Kind:           dashboard.KindOf(pr, b.renovateAuthors),
			AllowedActions: actions,
			ClosesIssues:   closingIssues(pr),
			Status:         dashboard.PullRequestStatus(pr, actions),
			ReadyToMerge:   dashboard.IsReadyToMerge(pr),
			NeedsReview:    dashboard.NeedsReview(pr),
			FailingCI:      dashboard.IsFailingCI(pr),

			ReviewRequestedFromMe: dashboard.ReviewRequestedFrom(pr, b.logins[pr.Forge]),
			AutoMerge:             b.autoMergeStatus(pr),
			AutoUpdate:            b.autoUpdate(pr),
			Queued:                b.waitingQueuedAction(pr),
			Hidden:                isHidden,
		}
		if isHidden && !hide.Until.IsZero() {
			until := hide.Until
			item.HiddenUntil = &until
		}
		out = append(out, item)
	}

	return out, hiddenDrafts, hiddenPullRequests
}

// forgetClosedHides deletes the hides of pull requests that are no longer open
// (#841), so the list can't grow without end, and drops them from b. A pull
// request counts as closed only when its forge answered and its repo is still
// tracked: an outage returns no pull requests, and that isn't a close. A
// failure to delete is logged and leaves the record for the next snapshot.
func (b *boardSettings) forgetClosedHides(ctx context.Context, store *settings.Store, userID []byte, snap dashboard.Snapshot) {
	if len(b.hidden) == 0 {
		return
	}
	index := indexSnapshot(snap)

	var gone []settings.HiddenPullRequest
	for _, h := range b.hidden {
		if index.closed(h.Forge, h.Repo, h.Number) {
			gone = append(gone, h)
		}
	}
	if len(gone) == 0 {
		return
	}
	if err := store.ForgetHiddenPullRequests(ctx, userID, gone); err != nil {
		slog.Warn("could not forget hidden pull requests that closed", "error", err)

		return
	}
	for _, h := range gone {
		delete(b.hidden, settings.AutoMergeKey(h.Forge, h.Repo, h.Number))
	}
}

// snapshotIndex answers whether a recorded pull request has closed.
type snapshotIndex struct {
	open      map[string]struct{}
	reachable map[dashboard.Forge]bool
	tracked   map[string]struct{}
}

func indexSnapshot(snap dashboard.Snapshot) snapshotIndex {
	idx := snapshotIndex{
		open:      make(map[string]struct{}, len(snap.PullRequests)),
		reachable: make(map[dashboard.Forge]bool, len(snap.Forges)),
		tracked:   make(map[string]struct{}, len(snap.Repos)),
	}
	for _, pr := range snap.PullRequests {
		idx.open[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)] = struct{}{}
	}
	for _, f := range snap.Forges {
		idx.reachable[f.Forge] = f.Reachable
	}
	for _, r := range snap.Repos {
		idx.tracked[settings.WebhookDeliveryKey(string(r.Forge), r.FullName)] = struct{}{}
	}

	return idx
}

// closed is true only when the pull request is not open, its forge answered
// and its repo is still tracked: an outage returns no pull requests, and that
// isn't a close.
func (idx snapshotIndex) closed(forge, repo string, number int) bool {
	if _, isOpen := idx.open[settings.AutoMergeKey(forge, repo, number)]; isOpen {
		return false
	}
	if !idx.reachable[dashboard.Forge(forge)] {
		return false
	}
	_, isTracked := idx.tracked[settings.WebhookDeliveryKey(forge, repo)]

	return isTracked
}

// allowedActions is the pull request's actions, minus an offer to update its
// branch where the repo updates branches itself (#1080): the app is about to
// do it. A blocked entry stays, since auto-update can't resolve a conflict and
// the user needs to hear about it. A release-please pull request keeps its
// offer: auto-update skips it, so nothing else will bring it up to date
// (#1104). Merge's "behind" reason then says who does.
func (b boardSettings) allowedActions(pr dashboard.PullRequest) []dashboard.ActionAvailability {
	actions := dashboard.AllowedActions(pr, b.renovateAuthors)
	_, repoAuto := b.autoUpdateBranch[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)]
	if dashboard.KindOf(pr, b.renovateAuthors) == dashboard.KindRelease {
		if !repoAuto {
			return actions
		}

		return explainBehind(actions, "Use Update branch. Auto-update skips release-please pull requests, and release-please only rewrites its branch for a new release.")
	}
	if !b.autoUpdate(pr).Enabled {
		return actions
	}
	left := slices.DeleteFunc(slices.Clone(actions), func(a dashboard.ActionAvailability) bool {
		return a.Action == dashboard.ActionUpdateBranch && a.Blocked == nil
	})
	if len(left) == len(actions) {
		return left
	}

	return explainBehind(left, "Auto-update is bringing it up to date automatically.")
}

// autoUpdate is pr's automatic-update state: its own choice when it has one,
// else its repo's setting.
func (b boardSettings) autoUpdate(pr dashboard.PullRequest) dashboard.AutoUpdate {
	_, repoAuto := b.autoUpdateBranch[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)]
	var own *bool
	if choice, ok := b.autoUpdateChoices[settings.AutoMergeKey(string(pr.Forge), pr.Repo, pr.Number)]; ok {
		own = &choice
	}

	return dashboard.PullRequestAutoUpdate(pr, repoAuto, own)
}

// explainBehind rewrites the next step on Merge's "behind" reason.
func explainBehind(actions []dashboard.ActionAvailability, next string) []dashboard.ActionAvailability {
	for i, a := range actions {
		if a.Action == dashboard.ActionMerge && a.Blocked != nil && a.Blocked.Code == dashboard.ActionBehind {
			blocked := *a.Blocked
			blocked.Next = next
			actions[i].Blocked = &blocked
		}
	}

	return actions
}

// issueFilter is what a user's own settings leave out of the issues they see
// (#1630).
type issueFilter struct {
	hideHousekeeping bool
	// titlesSet is whether the user has saved any pattern.
	titlesSet bool
	titles    dashboard.TitlePatterns
}

// hides reports whether the settings leave issue out.
func (f issueFilter) hides(issue dashboard.Issue, housekeeping bool) bool {
	return (f.hideHousekeeping && housekeeping) || f.titles.Matches(issue.Title)
}

// loadIssueFilter reads userID's issue settings. A store failure, or a saved
// pattern that no longer compiles, degrades to showing more, never to failing
// the response.
func loadIssueFilter(ctx context.Context, store *settings.Store, userID []byte) issueFilter {
	creds, err := store.Get(ctx, userID)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load issue settings for dashboard response", "error", err)
		}

		return issueFilter{}
	}
	titles, err := dashboard.CompileTitlePatterns(creds.IgnoredTitles)
	if err != nil {
		slog.Warn("could not compile ignored title patterns for dashboard response", "error", err)
	}

	return issueFilter{hideHousekeeping: creds.HideDependencyDashboard, titlesSet: len(creds.IgnoredTitles) > 0, titles: titles}
}

// issueViews leaves out the issues of ignored repos, then the ones filter
// hides, and counts the ones that are real work. It says how many the filter
// hid. Each carries the open pull requests that will close it, from prs, the
// snapshot's whole list: a draft or a hidden pull request counts, one in a
// repo whose pull requests are ignored does not.
func (b boardSettings) issueViews(issues []dashboard.Issue, prs []dashboard.PullRequest, filter issueFilter) (views []issueView, open, hidden int) {
	out := make([]issueView, 0, len(issues))
	visible := make([]dashboard.PullRequest, 0, len(prs))
	for _, pr := range prs {
		if !b.ignored[settings.WebhookDeliveryKey(string(pr.Forge), pr.Repo)].PRs {
			visible = append(visible, pr)
		}
	}
	index := dashboard.PullRequestsClosing(visible)
	for _, issue := range issues {
		if b.ignored[settings.WebhookDeliveryKey(string(issue.Forge), issue.Repo)].Issues {
			continue
		}
		housekeeping := dashboard.IsHousekeepingIssue(issue)
		if filter.hides(issue, housekeeping) {
			hidden++

			continue
		}
		out = append(out, issueView{
			Issue:        issue,
			Housekeeping: housekeeping,
			AuthorURL:    dashboard.ProfileURL(issue.Forge, dashboard.WebBase(issue.URL, issue.Repo), issue.Author),

			LinkedPullRequests: b.linkedPullRequests(index, issue),
		})
		if !housekeeping {
			open++
		}
	}

	return out, open, hidden
}

// viewOf reads includeDrafts and includeHidden from the query. Only "true"
// opts in, so a missing or malformed value gets the default: drafts (#791) and
// hidden pull requests (#841) left out.
func viewOf(r *http.Request) boardView {
	q := r.URL.Query()

	return boardView{includeDrafts: q.Get("includeDrafts") == "true", includeHidden: q.Get("includeHidden") == "true"}
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

// dashboardFor returns the dashboard data u's account currently has. Shared
// by handleDashboard and the MCP get_dashboard tool (mcp.go) so both read it
// the same way. Never blocks on either forge: Manager.Get reads whatever
// that user's background refresh last assembled -- empty, not an error, for a
// user who hasn't saved any credentials in Settings yet.
func dashboardFor(ctx context.Context, deps Deps, u *auth.User, view boardView) dashboardResponse {
	warmUpAggregator(ctx, deps, u.ID, u.Username)
	deps.Manager.WaitFirstRefresh(ctx, u.ID, deps.firstLoadWait())

	return buildDashboardResponse(ctx, deps, u.ID, deps.Manager.Get(u.ID), view)
}

// handleDashboard answers the signed-in user's own dashboard.
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

		resp := dashboardFor(r.Context(), deps, u, viewOf(r))
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
		writeJSON(w, http.StatusOK, buildDashboardResponse(r.Context(), deps, u.ID, deps.Manager.Get(u.ID), viewOf(r)))
	}
}

// handleDashboardStream pushes the signed-in user's own dashboard
// snapshot over Server-Sent Events every time their Aggregator produces
// a new one — most notably right after a verified webhook delivery
// triggers Manager.RefreshNow, which is what turns that into a live
// update instead of something only the next scheduled refresh picks up.
//
// The frontend's own poll against GET
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
			// send. EventSource does not retry a non-200, so the page opens
			// the stream again itself (Dashboard.svelte, ensureStream).
			writeJSON(w, http.StatusNotFound, errorBody("no background refresh is running yet for this user"))

			return
		}
		defer unsubscribe()

		// Read once: every event on this connection follows the choice it
		// opened with, and a client that changes its mind reconnects.
		view := viewOf(r)

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		streamSnapshots(r.Context(), deps.Drain.streamsStopped(), w, flusher, ch, func(snap dashboard.Snapshot) dashboardResponse {
			return buildDashboardResponse(r.Context(), deps, u.ID, snap, view)
		})
	}
}

// streamSnapshots writes one server-sent event for each snapshot that arrives
// on ch, until the client goes away, stopped closes (the server is shutting
// down), ch closes, or a write fails.
func streamSnapshots(ctx context.Context, stopped <-chan struct{}, w http.ResponseWriter, flusher http.Flusher, ch <-chan dashboard.Snapshot, render func(dashboard.Snapshot) dashboardResponse) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-stopped:
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
