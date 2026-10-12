package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	ghsdk "github.com/google/go-github/v75/github"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// requiredContextsTTL is how long a branch's required contexts are reused.
// Protection rules change rarely; this keeps a busy refresh from asking for
// them on every poll.
const requiredContextsTTL = 5 * time.Minute

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
	names   map[string]bool
	fetched time.Time
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
// context, and whether that could be told at all.
func (c *Client) hasUnreportedRequired(ctx context.Context, cand missingRequiredCheck) (missing, known bool) {
	required := c.requiredContextNames(ctx, cand)
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

	return false, true
}

// reportedContexts is every context the head commit has reported: check runs
// and commit statuses both. A required context can be either (an Actions job,
// or codecov/patch beside it), and listChecksForSHA reads statuses only when
// there are no check runs at all, which is right for a list of jobs but would
// call a reported status missing here.
func (c *Client) reportedContexts(ctx context.Context, owner, name, sha string) (map[string]bool, error) {
	reported := map[string]bool{}

	runsPath := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	slog.Debug("github request", "method", http.MethodGet, "url", runsPath)
	runs, runsResp, err := c.restClient.Checks.ListCheckRunsForRef(ctx, owner, name, sha, &ghsdk.ListCheckRunsOptions{PerPage: perPage})
	if err != nil {
		return nil, asClientError(c.restError(ctx, http.MethodGet, runsPath, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, runsPath, runsResp)
	for _, r := range runs.CheckRuns {
		reported[r.GetName()] = true
	}

	statusPath := fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, name, sha)
	slog.Debug("github request", "method", http.MethodGet, "url", statusPath)
	combined, statusResp, err := c.restClient.Repositories.GetCombinedStatus(ctx, owner, name, sha, nil)
	if err != nil {
		return nil, asClientError(c.restError(ctx, http.MethodGet, statusPath, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, statusPath, statusResp)
	for _, s := range combined.Statuses {
		reported[s.GetContext()] = true
	}

	return reported, nil
}

// requiredContextNames is the base branch's required contexts, from branch
// protection and active rulesets. Nothing readable (no admin scope) is none,
// which leaves the rollup's answer alone.
func (c *Client) requiredContextNames(ctx context.Context, cand missingRequiredCheck) map[string]bool {
	key := cand.owner + "/" + cand.name + "@" + cand.base
	if names, ok := c.requiredChecks.cachedContexts(key); ok {
		return names
	}
	names := map[string]bool{}
	c.protectionContexts(ctx, cand.owner, cand.name, cand.base, names)
	c.rulesetContexts(ctx, cand.owner, cand.name, cand.base, names)
	c.requiredChecks.storeContexts(key, names)

	return names
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

func (r *requiredChecks) cachedContexts(key string) (map[string]bool, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.contexts[key]
	if !ok || time.Since(entry.fetched) > requiredContextsTTL {
		return nil, false
	}

	return entry.names, true
}

func (r *requiredChecks) storeContexts(key string, names map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.contexts == nil {
		r.contexts = map[string]requiredContexts{}
	}
	r.contexts[key] = requiredContexts{names: names, fetched: time.Now()}
}
