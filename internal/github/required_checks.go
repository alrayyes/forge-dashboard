package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// requiredContextsTTL is how long a branch's required contexts are reused.
// Protection rules change rarely; this keeps a busy refresh from asking for
// them on every poll.
const requiredContextsTTL = 5 * time.Minute

// partialContextsTTL is how long a set a failed lookup left partial is reused.
// Short, so a lookup that was only flaky is retried soon; long enough that a
// repo whose protection can't be read (no admin scope) isn't asked about for
// every blocked pull request on every poll.
const partialContextsTTL = time.Minute

// requiredChecks remembers what the "required check hasn't reported yet" rule
// has learned (#1311), so a refresh doesn't repeat the same lookups.
type requiredChecks struct {
	mu sync.Mutex
	// complete holds head commits whose required contexts have all reported.
	// A commit's checks mostly move forward, so the answer is kept. A rerun on
	// the same commit adds a queued run it doesn't see; GitHub's own rollup goes
	// PENDING for that, so this is best effort for the window where it lags.
	complete map[string]struct{}
	// contexts is each "owner/name@base" branch's required contexts.
	contexts map[string]requiredContexts
	// held is each head commit's answer to "has a run awaiting approval", kept
	// for heldRunsTTL so a pull request that stays blocked isn't asked every poll.
	held map[string]heldAnswer
}

// heldRunsTTL is how long a head commit's held-run answer is reused. Short,
// because approving the runs changes it.
const heldRunsTTL = time.Minute

// heldAnswer is one lookup's result. unknown marks a lookup that failed: the
// pill reads it as "not held" so a token that can't read Actions isn't asked
// again for every pull request, but the panel doesn't trust it and asks again,
// so a transient error never hides a held run (#1966).
type heldAnswer struct {
	held    bool
	unknown bool
	fetched time.Time
	// runURL is the page of the newest held run, when the lookup listed the
	// runs (the panel's and the branch's do; the pull request pill's reads
	// only a count). A branch row links it (#2024).
	runURL string
}

func (r *requiredChecks) cachedHeld(sha string) (heldAnswer, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, found := r.held[sha]
	if !found || time.Since(a.fetched) > heldRunsTTL {
		return heldAnswer{}, false
	}

	return a, true
}

func (r *requiredChecks) storeHeld(sha string, held bool, runURL string) {
	r.storeAnswer(sha, heldAnswer{held: held, runURL: runURL, fetched: time.Now()})
}

// storeUnknownHeld remembers that the lookup failed.
func (r *requiredChecks) storeUnknownHeld(sha string) {
	r.storeAnswer(sha, heldAnswer{unknown: true, fetched: time.Now()})
}

func (r *requiredChecks) storeAnswer(sha string, answer heldAnswer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.held == nil {
		r.held = map[string]heldAnswer{}
	}
	for k, a := range r.held {
		if time.Since(a.fetched) > heldRunsTTL {
			delete(r.held, k)
		}
	}
	r.held[sha] = answer
}

type requiredContexts struct {
	names map[string]bool
	// answered is false when a lookup failed, so names may be partial. Such a
	// set is reused only briefly, and never decides a commit is complete.
	answered bool
	fetched  time.Time
}

// missingRequiredCheck is one pull request whose rollup says SUCCESS while
// GitHub still blocks it, so a required check may not have started.
type missingRequiredCheck struct {
	prIndex int
	owner   string
	name    string
	base    string
	headOid string
	// onlyChecksCanBlock is true when nothing GitHub reports on the pull request
	// explains BLOCKED but a required check: not a draft, no review outstanding.
	// It is the fallback for a repo whose required contexts can't be read.
	onlyChecksCanBlock bool
}

// requiredCheckCandidate reports whether a pull request needs the lookup:
// GitHub's rollup counts only contexts that exist, so SUCCESS beside BLOCKED
// can mean a required check that hasn't started (#1311). CLEAN means every
// required check passed already.
func requiredCheckCandidate(ci dashboard.CIStatus, mergeState string) bool {
	return ci == dashboard.CISuccess && mergeState == "BLOCKED"
}

// appendUnreported adds the last pull request in prs to candidates when it
// needs the lookup.
func appendUnreported(candidates []missingRequiredCheck, prs []dashboard.PullRequest, owner, name string, p graphqlPullRequest) []missingRequiredCheck {
	idx := len(prs) - 1
	if !requiredCheckCandidate(prs[idx].CI, p.MergeStateStatus) {
		return candidates
	}

	return append(candidates, missingRequiredCheck{
		prIndex: idx,
		owner:   owner,
		name:    name,
		base:    p.BaseRefName,
		headOid: p.HeadRefOid,

		onlyChecksCanBlock: onlyChecksCanBlock(p),
	})
}

// onlyChecksCanBlock reports whether a blocked pull request has no other
// visible reason to be blocked: it isn't a draft and its review decision isn't
// asking for a review or changes. Conflicts and a stale branch are other merge
// states, not BLOCKED. What it can't see (a merge queue, code owners with no
// decision, unresolved conversations) it gets wrong, in the pending direction.
func onlyChecksCanBlock(p graphqlPullRequest) bool {
	if p.IsDraft {
		return false
	}
	if p.ReviewDecision == nil {
		return true
	}

	return *p.ReviewDecision != "REVIEW_REQUIRED" && *p.ReviewDecision != "CHANGES_REQUESTED"
}

// requiredVerdict is what the required-check lookup could conclude.
type requiredVerdict int

const (
	// verdictKeepRollup: nothing to compare (a readable branch that requires
	// nothing) or the evidence failed to load (rate limit, 5xx). GitHub's
	// rollup stands.
	verdictKeepRollup requiredVerdict = iota
	// verdictMissing: a required context hasn't reported.
	verdictMissing
	// verdictComplete: every required context reported and every place that can
	// require one was read, so the answer holds for good.
	verdictComplete
	// verdictUnreadable: the required contexts couldn't be read in full (no
	// admin scope), so "nothing missing" can't be trusted.
	verdictUnreadable
)

// settleUnreportedRequiredChecks turns CI to pending for every candidate whose
// base branch requires a context the head commit hasn't reported. When the
// required contexts can't be read (no admin scope) and nothing else explains
// the block, the pull request reads pending too: the one thing left that can
// block it is a required check. That guess is never remembered as complete, so
// the next refresh asks again. A lookup that failed leaves the rollup's answer
// standing, like the other secondary calls.
func (c *Client) settleUnreportedRequiredChecks(ctx context.Context, prs []dashboard.PullRequest, candidates []missingRequiredCheck) {
	for _, cand := range candidates {
		if c.requiredChecks.isComplete(cand.headOid) {
			continue
		}
		switch c.hasUnreportedRequired(ctx, cand) {
		case verdictMissing:
			c.settleUnreported(ctx, prs, cand)
		case verdictUnreadable:
			if cand.onlyChecksCanBlock {
				c.settleUnreported(ctx, prs, cand)
			}
		case verdictComplete:
			c.requiredChecks.markComplete(cand.headOid)
		case verdictKeepRollup:
		}
	}
}

// settleUnreported reads a required check that hasn't reported as pending,
// unless workflow runs held for approval are why: those finished as
// action_required and create no check runs, so nothing is coming until a
// maintainer approves them (#1929). It then reads like any other held run
// (#1280): failing, and awaiting approval.
func (c *Client) settleUnreported(ctx context.Context, prs []dashboard.PullRequest, cand missingRequiredCheck) {
	if c.hasRunsAwaitingApproval(ctx, cand) {
		prs[cand.prIndex].CI = dashboard.CIFailure
		prs[cand.prIndex].AwaitingWorkflowApproval = true
		prs[cand.prIndex].FailingOnlyForApproval = true

		return
	}
	prs[cand.prIndex].CI = dashboard.CIPending
}

// hasRunsAwaitingApproval reports whether the head commit has a workflow run
// held as action_required. A failed lookup says no, so the pull request stays
// pending as before; a token that can't read Actions is expected and only
// logged at debug level, since it would repeat on every poll.
func (c *Client) hasRunsAwaitingApproval(ctx context.Context, cand missingRequiredCheck) bool {
	if answer, ok := c.requiredChecks.cachedHeld(cand.headOid); ok {
		return answer.held
	}
	path := fmt.Sprintf("/repos/%s/%s/actions/runs", cand.owner, cand.name)
	slog.Debug("github request", "method", http.MethodGet, "url", path)
	opts := &ghsdk.ListWorkflowRunsOptions{HeadSHA: cand.headOid, Status: "action_required"}
	opts.PerPage = 1
	runs, resp, err := c.restClient.Actions.ListRepositoryWorkflowRuns(ctx, cand.owner, cand.name, opts)
	if err != nil {
		level := slog.LevelWarn
		if clientErr, ok := errors.AsType[*dashboard.ClientError](asClientError(c.restError(ctx, http.MethodGet, path, err))); ok && clientErr.Kind == dashboard.ForgeErrorUnauthorized {
			level = slog.LevelDebug
		}
		slog.Log(ctx, level, "github awaiting-approval lookup failed", "forge", dashboard.ForgeGitHub, "error", err)
		// Remembered as unknown for the TTL, which reads as no here, so a token
		// that can't read Actions or a rate-limited poll isn't asked again for
		// every pull request.
		c.requiredChecks.storeUnknownHeld(cand.headOid)

		return false
	}
	c.recordRESTSuccess(ctx, http.MethodGet, path, resp)
	held := runs.GetTotalCount() > 0
	c.requiredChecks.storeHeld(cand.headOid, held, "")

	return held
}

// hasUnreportedRequired judges the head commit's required contexts. A missing
// context is missing whatever else failed to load, but "nothing missing" holds
// only when both places that can require a check (branch protection and
// rulesets) answered, since the one that didn't might name another.
func (c *Client) hasUnreportedRequired(ctx context.Context, cand missingRequiredCheck) requiredVerdict {
	required, answered := c.requiredContextNames(ctx, cand)
	if len(required) == 0 {
		if answered {
			return verdictKeepRollup
		}

		return verdictUnreadable
	}
	reported, err := c.reportedContexts(ctx, cand.owner, cand.name, cand.headOid)
	if err != nil {
		slog.Warn("github required-check lookup failed", "forge", dashboard.ForgeGitHub, "error", err)

		return verdictKeepRollup
	}
	for name := range required {
		if !reported[name] {
			return verdictMissing
		}
	}
	if answered {
		return verdictComplete
	}

	return verdictUnreadable
}

// reportedContexts is every context the head commit has reported a result for:
// check runs and commit statuses both. A run that is queued or in progress, or
// a status still pending, has not reported yet: GitHub's rollup can read SUCCESS
// for a moment after a push while the required jobs are still waiting (#1311).
// The list returns the latest run of each name, so a rerun is judged by its own
// state. A required context can be either (an Actions job,
// or codecov/patch beside it), and listChecksForSHA reads statuses only when
// there are no check runs at all, which is right for a list of jobs but would
// call a reported status missing here.
func (c *Client) reportedContexts(ctx context.Context, owner, name, sha string) (map[string]bool, error) {
	reported := map[string]bool{}
	if err := c.addReportedRuns(ctx, owner, name, sha, reported); err != nil {
		return nil, err
	}
	if err := c.addReportedStatuses(ctx, owner, name, sha, reported); err != nil {
		return nil, err
	}

	return reported, nil
}

// addReportedRuns marks a check name as reported when every run of that name on
// the commit has completed. Two workflows can have a job of the same name, and
// the one still queued must not be hidden by the one that finished.
func (c *Client) addReportedRuns(ctx context.Context, owner, name, sha string, reported map[string]bool) error {
	unfinished := map[string]bool{}
	runsPath := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	runOpts := &ghsdk.ListCheckRunsOptions{}
	runOpts.PerPage = perPage
	for opts := runOpts; ; {
		slog.Debug("github request", "method", http.MethodGet, "url", runsPath, "page", opts.Page)
		runs, resp, err := c.restClient.Checks.ListCheckRunsForRef(ctx, owner, name, sha, opts)
		if err != nil {
			return asClientError(c.restError(ctx, http.MethodGet, runsPath, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, runsPath, resp)
		for _, r := range runs.CheckRuns {
			if r.GetStatus() != "completed" {
				unfinished[r.GetName()] = true

				continue
			}
			reported[r.GetName()] = true
		}
		if resp.NextPage == 0 {
			for n := range unfinished {
				delete(reported, n)
			}

			return nil
		}
		opts.Page = resp.NextPage
	}
}

// addReportedStatuses marks every commit status that has left pending as
// reported.
func (c *Client) addReportedStatuses(ctx context.Context, owner, name, sha string, reported map[string]bool) error {
	statusPath := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	for opts := (&ghsdk.ListOptions{PerPage: perPage}); ; {
		slog.Debug("github request", "method", http.MethodGet, "url", statusPath, "page", opts.Page)
		combined, resp, err := c.restClient.Repositories.GetCombinedStatus(ctx, owner, name, sha, opts)
		if err != nil {
			return asClientError(c.restError(ctx, http.MethodGet, statusPath, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, statusPath, resp)
		for _, s := range combined.Statuses {
			if s.GetState() != "pending" {
				reported[s.GetContext()] = true
			}
		}
		if resp.NextPage == 0 {
			return nil
		}
		opts.Page = resp.NextPage
	}
}

// requiredContextNames is the base branch's required contexts, from branch
// protection and active rulesets, and whether both lookups answered. A partial
// set is cached too, but only for partialContextsTTL, and answered stays false
// so it never marks a commit complete; a set that nothing could read (no admin
// scope) is empty, which sends the settle step to that fallback.
func (c *Client) requiredContextNames(ctx context.Context, cand missingRequiredCheck) (names map[string]bool, answered bool) {
	key := cand.owner + "/" + cand.name + "@" + cand.base
	if cached, answered, ok := c.requiredChecks.cachedContexts(key); ok {
		return cached, answered
	}
	names = map[string]bool{}
	protKnown := c.protectionContexts(ctx, cand.owner, cand.name, cand.base, names)
	rulesKnown := c.rulesetContexts(ctx, cand.owner, cand.name, cand.base, names)
	answered = protKnown && rulesKnown
	// The store says whether this answer is the first unreadable one since the
	// branch was last read in full, so the warning is decided under the same
	// lock as the store: once until it can be read again (#1387). Without the
	// required contexts the settle step falls back to merge state and review
	// decision (onlyChecksCanBlock). A repo that is readable and simply requires
	// no checks is not worth a warning.
	if c.requiredChecks.storeContexts(key, names, answered) {
		slog.Warn("github required checks unreadable; a blocked pull request with no review outstanding reads pending",
			"forge", dashboard.ForgeGitHub, "repo", cand.owner+"/"+cand.name, "base", cand.base,
			"protectionRead", protKnown, "rulesetsRead", rulesKnown, "contexts", len(names))
	}

	return names, answered
}

func (r *requiredChecks) isComplete(sha string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.complete[sha]

	return ok
}

func (r *requiredChecks) markComplete(sha string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.complete == nil {
		r.complete = map[string]struct{}{}
	}
	r.complete[sha] = struct{}{}
}

func (r *requiredChecks) cachedContexts(key string) (names map[string]bool, answered, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, found := r.contexts[key]
	if !found {
		return nil, false, false
	}
	ttl := requiredContextsTTL
	if !entry.answered {
		ttl = partialContextsTTL
	}
	if time.Since(entry.fetched) > ttl {
		return nil, false, false
	}

	return entry.names, entry.answered, true
}

// storeContexts remembers a branch's required contexts and reports whether this
// answer is unreadable and the previous one, if any, was not: the first
// unreadable answer since the branch was last read in full.
func (r *requiredChecks) storeContexts(key string, names map[string]bool, answered bool) (newlyUnreadable bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.contexts == nil {
		r.contexts = map[string]requiredContexts{}
	}
	previous, had := r.contexts[key]
	r.contexts[key] = requiredContexts{names: names, answered: answered, fetched: time.Now()}

	return !answered && (!had || previous.answered)
}
