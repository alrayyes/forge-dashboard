package github

import (
	"context"
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
	// A commit's checks only move forward, so that answer never expires.
	complete map[string]struct{}
	// contexts is each "owner/name@base" branch's required contexts.
	contexts map[string]requiredContexts
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
	})
}

// settleUnreportedRequiredChecks turns CI to pending for every candidate whose
// base branch requires a context the head commit hasn't reported. Lookups that
// fail leave the rollup's answer standing, like the other secondary calls.
func (c *Client) settleUnreportedRequiredChecks(ctx context.Context, prs []dashboard.PullRequest, candidates []missingRequiredCheck) {
	for _, cand := range candidates {
		if c.requiredChecks.isComplete(cand.headOid) {
			continue
		}
		missing, known := c.hasUnreportedRequired(ctx, cand)
		switch {
		case !known:
		case missing:
			prs[cand.prIndex].CI = dashboard.CIPending
		default:
			c.requiredChecks.markComplete(cand.headOid)
		}
	}
}

// hasUnreportedRequired reports whether the head commit lacks a required
// context, and whether the answer can be trusted for good. A missing context
// is missing whatever else failed to load, but "nothing missing" holds only
// when both places that can require a check (branch protection and rulesets)
// answered, since the one that didn't might name another.
func (c *Client) hasUnreportedRequired(ctx context.Context, cand missingRequiredCheck) (missing, known bool) {
	required, answered := c.requiredContextNames(ctx, cand)
	if len(required) == 0 {
		return false, false
	}
	reported, err := c.reportedContexts(ctx, cand.owner, cand.name, cand.headOid)
	if err != nil {
		slog.Warn("github required-check lookup failed", "forge", dashboard.ForgeGitHub, "error", err)

		return false, false
	}
	for name := range required {
		if !reported[name] {
			return true, true
		}
	}

	return false, answered
}

// reportedContexts is every context the head commit has reported: check runs
// and commit statuses both. A required context can be either (an Actions job,
// or codecov/patch beside it), and listChecksForSHA reads statuses only when
// there are no check runs at all, which is right for a list of jobs but would
// call a reported status missing here.
func (c *Client) reportedContexts(ctx context.Context, owner, name, sha string) (map[string]bool, error) {
	reported := map[string]bool{}

	runsPath := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	runOpts := &ghsdk.ListCheckRunsOptions{}
	runOpts.PerPage = perPage
	for opts := runOpts; ; {
		slog.Debug("github request", "method", http.MethodGet, "url", runsPath, "page", opts.Page)
		runs, resp, err := c.restClient.Checks.ListCheckRunsForRef(ctx, owner, name, sha, opts)
		if err != nil {
			return nil, asClientError(c.restError(ctx, http.MethodGet, runsPath, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, runsPath, resp)
		for _, r := range runs.CheckRuns {
			reported[r.GetName()] = true
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}

	statusPath := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	for opts := (&ghsdk.ListOptions{PerPage: perPage}); ; {
		slog.Debug("github request", "method", http.MethodGet, "url", statusPath, "page", opts.Page)
		combined, resp, err := c.restClient.Repositories.GetCombinedStatus(ctx, owner, name, sha, opts)
		if err != nil {
			return nil, asClientError(c.restError(ctx, http.MethodGet, statusPath, err))
		}
		c.recordRESTSuccess(ctx, http.MethodGet, statusPath, resp)
		for _, s := range combined.Statuses {
			reported[s.GetContext()] = true
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}

	return reported, nil
}

// requiredContextNames is the base branch's required contexts, from branch
// protection and active rulesets, and whether both lookups answered. A partial
// set is cached too, but only for partialContextsTTL, and answered stays false
// so it never marks a commit complete; a set that nothing could read (no admin
// scope) is empty and leaves the combined status's answer alone.
func (c *Client) requiredContextNames(ctx context.Context, cand missingRequiredCheck) (names map[string]bool, answered bool) {
	key := cand.owner + "/" + cand.name + "@" + cand.base
	if cached, answered, ok := c.requiredChecks.cachedContexts(key); ok {
		return cached, answered
	}
	names = map[string]bool{}
	protKnown := c.protectionContexts(ctx, cand.owner, cand.name, cand.base, names)
	rulesKnown := c.rulesetContexts(ctx, cand.owner, cand.name, cand.base, names)
	answered = protKnown && rulesKnown
	c.requiredChecks.storeContexts(key, names, answered)

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

func (r *requiredChecks) storeContexts(key string, names map[string]bool, answered bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.contexts == nil {
		r.contexts = map[string]requiredContexts{}
	}
	r.contexts[key] = requiredContexts{names: names, answered: answered, fetched: time.Now()}
}
