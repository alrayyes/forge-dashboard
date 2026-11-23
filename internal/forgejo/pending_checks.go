package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// requiredGlobsTTL is how long a branch's required contexts are reused. Rules
// change rarely, and a refresh asks once per pull request otherwise.
const requiredGlobsTTL = 5 * time.Minute

// requiredGlobsCache remembers each "owner/name@base" branch's required status
// contexts. The zero value is ready to use.
type requiredGlobsCache struct {
	mu      sync.Mutex
	answers map[string]requiredGlobsAnswer
}

type requiredGlobsAnswer struct {
	globs   []string
	fetched time.Time
}

func (r *requiredGlobsCache) cached(key string) ([]string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.answers[key]
	if !ok || time.Since(a.fetched) > requiredGlobsTTL {
		return nil, false
	}

	return a.globs, true
}

func (r *requiredGlobsCache) store(key string, globs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.answers == nil {
		r.answers = map[string]requiredGlobsAnswer{}
	}
	r.answers[key] = requiredGlobsAnswer{globs: globs, fetched: time.Now()}
}

// requiredContexts is the status-check patterns base's rule requires. It is
// none when the rule list can't be read (it needs admin on the repo), so a row
// is never guessed pending from a rule nobody saw.
func (c *Client) requiredContexts(ctx context.Context, owner, name, base string) []string {
	if base == "" {
		return nil
	}
	key := owner + "/" + name + "@" + base
	if globs, ok := c.required.cached(key); ok {
		return globs
	}
	c = c.withContext(ctx)
	protPath := fmt.Sprintf("/repos/%s/%s/branch_protections", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", protPath)
	var opt gitea.ListBranchProtectionsOptions
	opt.PageSize = pageLimit
	rules, resp, err := c.sdk.ListBranchProtections(owner, name, opt)
	var globs []string
	if err != nil {
		slog.Debug("forgejo branch protections unreadable, no required check is missed", "repo", owner+"/"+name, "branch", base, "error", err)
	} else {
		c.recordRequest(ctx, http.MethodGet, protPath, resp.StatusCode, requestlog.OutcomeSuccess)
		if rule := protectionForBranch(rules, base); rule != nil && rule.EnableStatusCheck {
			globs = rule.StatusCheckContexts
		}
	}
	if ctx.Err() != nil {
		return globs
	}
	c.required.store(key, globs)

	return globs
}

// unreportedContexts are the patterns no reported context matches.
func unreportedContexts(globs, reported []string) []string {
	var missing []string
	for _, g := range globs {
		re := globRegexp(g, false)
		found := false
		for _, r := range reported {
			if re.MatchString(r) {
				found = true

				break
			}
		}
		if !found {
			missing = append(missing, g)
		}
	}

	return missing
}

// unjobbedPending names the pending statuses no Actions job stands behind.
func unjobbedPending(statuses []*gitea.Status) []string {
	var names []string
	for _, s := range statuses {
		if s == nil || s.State != gitea.StatusPending {
			continue
		}
		if _, _, isJob := jobTarget(s); !isJob {
			names = append(names, s.Context)
		}
	}

	return names
}

func statusContexts(statuses []*gitea.Status) []string {
	out := make([]string, 0, len(statuses))
	for _, s := range statuses {
		if s != nil {
			out = append(out, s.Context)
		}
	}

	return out
}

// withUnreportedRequired reads a required context nothing has reported as a
// wait, so the row stays pending and the reason can name it (#4442). It only
// speaks when nothing else explains the row: no failure and no check going,
// since a job still queued with no status may be that very context.
func (c *Client) withUnreportedRequired(ctx context.Context, owner, name, base string, statuses []*gitea.Status, state dashboard.CIStatus, counts dashboard.CheckCounts) (dashboard.CIStatus, dashboard.CheckCounts, []string) {
	if state != dashboard.CISuccess || len(statuses) == 0 {
		return state, counts, nil
	}
	if counts.Failed > 0 || counts.Waiting > 0 || counts.Running > 0 {
		return state, counts, nil
	}
	missing := unreportedContexts(c.requiredContexts(ctx, owner, name, base), statusContexts(statuses))
	if len(missing) == 0 {
		return state, counts, nil
	}
	counts.Waiting += len(missing)

	return dashboard.CIPending, counts, missing
}

// withUnreportedRequiredChecks lists a required context nothing has reported
// as a queued check, so the list agrees with the row's counts (#4442). Like
// the counts, it speaks only when no listed check is failing or going.
func (c *Client) withUnreportedRequiredChecks(ctx context.Context, owner, name, base string, checks []dashboard.Check, probes []string) []dashboard.Check {
	if len(checks) == 0 {
		return checks
	}
	reported := make([]string, 0, len(checks))
	for _, ch := range checks {
		switch ch.State {
		case dashboard.CheckSuccess:
		default:
			return checks
		}
		reported = append(reported, ch.Name)
	}
	reported = append(reported, probes...)
	for _, m := range unreportedContexts(c.requiredContexts(ctx, owner, name, base), reported) {
		checks = append(checks, dashboard.Check{Name: m, State: dashboard.CheckQueued, Required: new(true)})
	}

	return checks
}
