package github

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// probeBatchSize is how many repos one aliased probe query names. The probe
// selects a handful of scalars and two single-node connections per repo, so a
// batch is far under GitHub's node limit and costs about one point.
const probeBatchSize = 50

// probeRepoFields is the cheap selection that says whether a repo changed:
// when it was last pushed to or edited, and, for its open pull requests and
// issues, how many there are and when the newest-touched one last changed. A
// comment, a label, a review or a new or closed item moves one of these; a
// finished check run does not, which is why a repo is only ever skipped while
// its webhook is confirmed (it delivers check events).
const probeRepoFields = `
    pushedAt
    updatedAt
    openPRs: pullRequests(states: OPEN, first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        updatedAt
      }
    }
    openIssues: issues(states: OPEN, first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        updatedAt
      }
    }
`

// probeTokenQuery lists the repos a personal token can push to with the probe
// selection, a hundred per page instead of the fifty the full query affords.
const probeTokenQuery = `
query($cursor: String) {
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
  viewer {
    repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR], isFork: false) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        url
        isArchived
        isFork
        viewerPermission
        usesCustomOpenGraphImage
        openGraphImageUrl
        owner {
          login
        }
` + probeRepoFields + `
      }
    }
  }
}
`

// probeNode is one repo's answer to probeRepoFields.
type probeNode struct {
	PushedAt   string     `json:"pushedAt"`
	UpdatedAt  string     `json:"updatedAt"`
	OpenPRs    probeCount `json:"openPRs"`
	OpenIssues probeCount `json:"openIssues"`
}

// probeCount is a connection's total and the newest-touched node's time.
type probeCount struct {
	TotalCount int `json:"totalCount"`
	Nodes      []struct {
		UpdatedAt string `json:"updatedAt"`
	} `json:"nodes"`
}

func newest(c probeCount) string {
	if len(c.Nodes) == 0 {
		return ""
	}

	return c.Nodes[0].UpdatedAt
}

// repoStamp is what a repo looked like to the probe. Two equal stamps mean none
// of the signals the probe reads moved.
type repoStamp struct {
	pushedAt, updatedAt   string
	openPRs, openIssues   int
	newestPR, newestIssue string
}

func (n probeNode) stamp() repoStamp {
	return repoStamp{
		pushedAt: n.PushedAt, updatedAt: n.UpdatedAt,
		openPRs: n.OpenPRs.TotalCount, openIssues: n.OpenIssues.TotalCount,
		newestPR: newest(n.OpenPRs), newestIssue: newest(n.OpenIssues),
	}
}

// probedRepo is a repo as the probe saw it: enough identity to name it, check
// its hook and build its repo row, and the stamp taken before any fetch.
type probedRepo struct {
	repo  graphqlRepo
	stamp repoStamp
}

func (p probedRepo) fullName() string { return p.repo.Owner.Login + "/" + p.repo.Name }

// stampBook holds the stamp of every repo whose pull requests and issues were
// fetched whole, keyed by full name. In memory only: a restart forgets it, so
// the first refresh after a start fetches everything.
type stampBook struct {
	mu sync.Mutex
	m  map[string]repoStamp
}

func (b *stampBook) get() map[string]repoStamp {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]repoStamp, len(b.m))
	maps.Copy(out, b.m)

	return out
}

func (b *stampBook) set(m map[string]repoStamp) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.m = m
}

// refreshPlan is what the probe and the hook checks decided for one refresh.
type refreshPlan struct {
	// listed is every repo the probe saw, tracked or not, for pruning saved
	// hook checks.
	listed []graphqlRepo
	// tracked is the ones the dashboard follows, in the probe's order.
	tracked []probedRepo
	// changed is the tracked repos to fetch in full; skipped names the rest.
	changed []probedRepo
	skipped []string
	// hooks is this refresh's answer from every tracked repo's hook listing.
	hooks     map[string]hookProbe
	rateLimit *dashboard.RateLimit
	// candidates is the App installation's repo listing, reused by a full
	// fetch so it is not listed twice. Nil for a token.
	candidates []*ghsdk.Repository
}

// partial reports whether the plan skips anything, which is the only time the
// account-wide query is replaced by one for the changed repos alone.
func (p *refreshPlan) partial() bool { return p != nil && len(p.skipped) > 0 }

func (p *refreshPlan) trackedRepos() []graphqlRepo {
	out := make([]graphqlRepo, 0, len(p.tracked))
	for _, t := range p.tracked {
		out = append(out, t.repo)
	}

	return out
}

// planRefresh probes the account and decides which repos a refresh must fetch.
// It returns nil when no skip is possible or the probe can't be trusted, which
// sends the caller down the account-wide path. Without a webhook path nothing
// is ever confirmed, so nothing could be skipped and nothing is probed.
func (c *Client) planRefresh(ctx context.Context) *refreshPlan {
	if c.webhookPath == "" {
		c.stamps.set(nil)

		return nil
	}
	probed, rateLimit, candidates, err := c.probeRepos(ctx)
	if err != nil {
		slog.Warn("github change probe failed, fetching every repo", "forge", dashboard.ForgeGitHub, "error", err)
		c.stamps.set(nil)

		return nil
	}

	plan := &refreshPlan{rateLimit: rateLimit, candidates: candidates}
	for _, p := range probed {
		plan.listed = append(plan.listed, p.repo)
	}
	plan.tracked = trackedProbed(probed)
	plan.hooks = c.checkWebhooks(ctx, plan.trackedRepos())

	incremental := dashboard.Incremental(ctx)
	known := c.stamps.get()
	for _, p := range plan.tracked {
		name := p.fullName()
		if before, ok := known[name]; incremental && ok && before == p.stamp && plan.hooks[name].has {
			plan.skipped = append(plan.skipped, name)

			continue
		}
		plan.changed = append(plan.changed, p)
	}

	return plan
}

func trackedProbed(probed []probedRepo) []probedRepo {
	out := make([]probedRepo, 0, len(probed))
	for _, p := range probed {
		if p.repo.IsArchived || p.repo.IsFork || !hasWriteAccess(p.repo.ViewerPermission) {
			continue
		}
		out = append(out, p)
	}

	return out
}

// probeRepos reads every repo's stamp: one paginated query for a token, a
// listing plus aliased batches for an App installation.
func (c *Client) probeRepos(ctx context.Context) ([]probedRepo, *dashboard.RateLimit, []*ghsdk.Repository, error) {
	if c.appAuthenticated {
		return c.probeAppRepos(ctx)
	}
	probed, rateLimit, err := c.probeTokenRepos(ctx)

	return probed, rateLimit, nil, err
}

func (c *Client) probeTokenRepos(ctx context.Context) ([]probedRepo, *dashboard.RateLimit, error) {
	var probed []probedRepo
	var rateLimit *dashboard.RateLimit
	var cursor *string
	for {
		var resp struct {
			RateLimit *struct {
				Limit     int       `json:"limit"`
				Cost      int       `json:"cost"`
				Remaining int       `json:"remaining"`
				ResetAt   time.Time `json:"resetAt"`
			} `json:"rateLimit"`
			Viewer struct {
				Repositories struct {
					PageInfo struct {
						HasNextPage bool   `json:"hasNextPage"`
						EndCursor   string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []json.RawMessage `json:"nodes"`
				} `json:"repositories"`
			} `json:"viewer"`
		}
		if err := c.graphqlDo(ctx, probeTokenQuery, map[string]any{"cursor": cursor}, &resp); err != nil {
			return nil, rateLimit, err
		}
		if resp.RateLimit != nil {
			rateLimit = &dashboard.RateLimit{
				Limit: resp.RateLimit.Limit, Remaining: resp.RateLimit.Remaining,
				ResetsAt: resp.RateLimit.ResetAt, Cost: resp.RateLimit.Cost,
			}
			slog.Info("github graphql rate limit", "cost", resp.RateLimit.Cost, "remaining", resp.RateLimit.Remaining, "limit", resp.RateLimit.Limit)
		}
		for _, raw := range resp.Viewer.Repositories.Nodes {
			var repo graphqlRepo
			var probe probeNode
			if err := json.Unmarshal(raw, &repo); err != nil {
				return nil, rateLimit, fmt.Errorf("github: decode probe: %w", err)
			}
			if err := json.Unmarshal(raw, &probe); err != nil {
				return nil, rateLimit, fmt.Errorf("github: decode probe: %w", err)
			}
			probed = append(probed, probedRepo{repo: repo, stamp: probe.stamp()})
		}
		if !resp.Viewer.Repositories.PageInfo.HasNextPage {
			return probed, rateLimit, nil
		}
		endCursor := resp.Viewer.Repositories.PageInfo.EndCursor
		cursor = &endCursor
	}
}

func (c *Client) probeAppRepos(ctx context.Context) ([]probedRepo, *dashboard.RateLimit, []*ghsdk.Repository, error) {
	candidates, err := c.listAppRepos(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	var probed []probedRepo
	var rateLimit *dashboard.RateLimit
	for start := 0; start < len(candidates); start += probeBatchSize {
		batch := candidates[start:min(start+probeBatchSize, len(candidates))]
		got, rl, err := c.probeBatch(ctx, batch)
		if rl != nil {
			rateLimit = rl
		}
		if err != nil {
			return nil, rateLimit, nil, err
		}
		probed = append(probed, got...)
	}

	return probed, rateLimit, candidates, nil
}

// probeBatch probes one aliased batch of an App installation's repos.
func (c *Client) probeBatch(ctx context.Context, batch []*ghsdk.Repository) ([]probedRepo, *dashboard.RateLimit, error) {
	query, vars := buildAliasedQuery(batch, probeRepoFields, false)
	var raw json.RawMessage
	if err := c.graphqlDo(ctx, query, vars, &raw); err != nil {
		return nil, nil, err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, nil, fmt.Errorf("github: decode probe batch: %w", err)
	}
	rateLimit, _ := decodeRateLimit(envelope["rateLimit"])
	var probed []probedRepo
	for i, r := range batch {
		body, ok := envelope[fmt.Sprintf("r%d", i)]
		if !ok {
			continue
		}
		var probe probeNode
		if err := json.Unmarshal(body, &probe); err != nil {
			return nil, rateLimit, fmt.Errorf("github: decode probe batch: %w", err)
		}
		probed = append(probed, probedRepo{repo: appRepoIdentity(r), stamp: probe.stamp()})
	}

	return probed, rateLimit, nil
}

// appRepoIdentity is the graphqlRepo an App listing entry stands for. An
// installation token has no viewer role, so every listed repo is tracked at
// WRITE (see decodeAppRepoBatch).
func appRepoIdentity(r *ghsdk.Repository) graphqlRepo {
	repo := graphqlRepo{Name: r.GetName(), URL: r.GetHTMLURL(), ViewerPermission: "WRITE"}
	repo.Owner.Login = r.GetOwner().GetLogin()

	return repo
}

func decodeRateLimit(raw json.RawMessage) (*dashboard.RateLimit, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var rl struct {
		Limit     int       `json:"limit"`
		Cost      int       `json:"cost"`
		Remaining int       `json:"remaining"`
		ResetAt   time.Time `json:"resetAt"`
	}
	if err := json.Unmarshal(raw, &rl); err != nil {
		return nil, false
	}

	return &dashboard.RateLimit{Limit: rl.Limit, Remaining: rl.Remaining, ResetsAt: rl.ResetAt, Cost: rl.Cost}, true
}

// fetchNamedRepos fetches the pull requests, issues and default branch of the
// named repos in aliased batches: the account-wide query's content for the
// repos that changed and no others. A token's viewer role comes from the probe;
// an App's is WRITE, as decodeAppRepoBatch says.
func (c *Client) fetchNamedRepos(ctx context.Context, named []probedRepo, since *time.Time) ([]graphqlRepo, *dashboard.RateLimit, error) {
	candidates := make([]*ghsdk.Repository, 0, len(named))
	roles := make(map[string]string, len(named))
	for _, p := range named {
		candidates = append(candidates, &ghsdk.Repository{
			Name: new(p.repo.Name), HTMLURL: new(p.repo.URL),
			Owner: &ghsdk.User{Login: new(p.repo.Owner.Login)},
		})
		roles[p.fullName()] = p.repo.ViewerPermission
	}
	repos, rateLimit, err := c.fetchRepoBatches(ctx, candidates, since)
	if err != nil {
		return nil, rateLimit, err
	}
	for i := range repos {
		if role, ok := roles[repos[i].Owner.Login+"/"+repos[i].Name]; ok && !c.appAuthenticated {
			repos[i].ViewerPermission = role
		}
	}

	return repos, rateLimit, nil
}

// recordStamps remembers the probe's stamp for every repo whose rows are now
// whole: the skipped ones, whose stamp still holds, and the fetched ones whose
// issues reconciled. A repo missing from either has no stamp, so the next
// refresh fetches it.
func (c *Client) recordStamps(plan *refreshPlan, fetched map[string]bool) {
	if plan == nil {
		c.stamps.set(nil)

		return
	}
	skipped := make(map[string]bool, len(plan.skipped))
	for _, name := range plan.skipped {
		skipped[name] = true
	}
	next := make(map[string]repoStamp, len(plan.tracked))
	for _, p := range plan.tracked {
		if name := p.fullName(); skipped[name] || fetched[name] {
			next[name] = p.stamp
		}
	}
	c.stamps.set(next)
}

// buildAliasedQuery returns a query naming each repo as r0, r1, ... with fields
// selected under each, and its variables. withSince adds the $since variable
// the issues selection filters on.
func buildAliasedQuery(repos []*ghsdk.Repository, fields string, withSince bool) (string, map[string]any) {
	varDecls := make([]string, 0, len(repos)*2+1)
	vars := make(map[string]any, len(repos)*2+1)
	if withSince {
		varDecls = append(varDecls, "$since: DateTime")
	}
	for i, r := range repos {
		ownerVar, nameVar := fmt.Sprintf("owner%d", i), fmt.Sprintf("name%d", i)
		varDecls = append(varDecls, fmt.Sprintf("$%s: String!", ownerVar), fmt.Sprintf("$%s: String!", nameVar))
		vars[ownerVar] = r.GetOwner().GetLogin()
		vars[nameVar] = r.GetName()
	}

	var q strings.Builder
	q.WriteString("query(")
	q.WriteString(strings.Join(varDecls, ", "))
	q.WriteString(") {\n  rateLimit {\n    limit\n    cost\n    remaining\n    resetAt\n  }\n")
	for i := range repos {
		fmt.Fprintf(&q, "  r%d: repository(owner: $owner%d, name: $name%d) {%s  }\n", i, i, i, fields)
	}
	q.WriteString("}")

	return q.String(), vars
}
