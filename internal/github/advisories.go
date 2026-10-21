package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// advisoriesTTL is how long a repo's advisory answer is reused. Alerts change
// on the scale of hours, and a webhook-scoped refresh would otherwise ask again
// for every finished check.
const advisoriesTTL = 15 * time.Minute

// advisoriesRetry is how long a failed read waits before it is tried again, so
// an outage or a spent rate limit costs one call per repo per interval, not one
// per refresh.
const advisoriesRetry = 5 * time.Minute

// maxAlertPages bounds the pages read for one repo: 100 alerts a page. A repo
// with more open alerts than that reads as unknown rather than as a count that
// stops short of the truth.
const maxAlertPages = 10

// errAdvisoriesThrottled marks a read GitHub refused for rate limiting. Unlike
// a 403 for a missing scope it says nothing about the repo, so it never
// replaces an answer already known.
var errAdvisoriesThrottled = errors.New("rate limited")

// dependabotAlertLister is the one go-github call the advisory read needs,
// behind an interface of our own so a test or another SDK can stand in.
type dependabotAlertLister interface {
	ListRepoAlerts(ctx context.Context, owner, repo string, opts *ghsdk.ListAlertsOptions) ([]*ghsdk.DependabotAlert, *ghsdk.Response, error)
}

// advisoryCache remembers each repo's last advisory answer and when to ask again.
type advisoryCache struct {
	mu      sync.Mutex
	entries map[string]advisoryEntry
}

type advisoryEntry struct {
	value   dashboard.Advisories
	expires time.Time
}

// get returns the cached answer and whether it is still fresh.
func (c *advisoryCache) get(repo string) (v dashboard.Advisories, fresh, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[repo]

	return e.value, ok && time.Now().Before(e.expires), ok
}

func (c *advisoryCache) put(repo string, v dashboard.Advisories, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]advisoryEntry{}
	}
	c.entries[repo] = advisoryEntry{value: v, expires: time.Now().Add(ttl)}
}

// ReadAdvisories implements dashboard.AdvisoryReader from the repository's open
// Dependabot alerts (GET /repos/{owner}/{repo}/dependabot/alerts?state=open),
// following the cursor GitHub pages them by. GitHub answers 404 where alerts
// are switched off and 403 where the token lacks the security_events scope (or
// the Dependabot alerts permission); both are "unknown", never a zero count. So
// is a repo with more alerts than maxAlertPages hold. A rate limit is an error.
func (c *Client) ReadAdvisories(ctx context.Context, owner, name, repoURL string) (dashboard.Advisories, error) {
	return readAdvisories(ctx, c.restClient.Dependabot, owner, name, repoURL)
}

func readAdvisories(ctx context.Context, lister dependabotAlertLister, owner, name, repoURL string) (dashboard.Advisories, error) {
	state := "open"
	opts := &ghsdk.ListAlertsOptions{State: &state, ListOptions: ghsdk.ListOptions{PerPage: perPage}}
	out := dashboard.Advisories{State: dashboard.AdvisoriesKnown}

	for range maxAlertPages {
		alerts, resp, err := lister.ListRepoAlerts(ctx, owner, name, opts)
		if err != nil {
			if throttled(err) {
				return dashboard.Advisories{}, fmt.Errorf("list dependabot alerts: %w", errAdvisoriesThrottled)
			}
			if refused(err) {
				return dashboard.Advisories{State: dashboard.AdvisoriesUnknown}, nil
			}

			return dashboard.Advisories{}, fmt.Errorf("list dependabot alerts: %w", err)
		}
		for _, a := range alerts {
			out.Count++
			sev := dashboard.AdvisorySeverity(a.GetSecurityAdvisory().GetSeverity())
			if sev.Rank() > out.Highest.Rank() {
				out.Highest = sev
			}
		}
		if resp.After == "" {
			if out.Count > 0 {
				out.URL = repoURL + "/security/dependabot"
			}

			return out, nil
		}
		opts.After = resp.After
	}

	return dashboard.Advisories{State: dashboard.AdvisoriesUnknown}, nil
}

// throttled reports a primary or secondary rate limit.
func throttled(err error) bool {
	if _, ok := errors.AsType[*ghsdk.RateLimitError](err); ok {
		return true
	}
	_, ok := errors.AsType[*ghsdk.AbuseRateLimitError](err)

	return ok
}

// refused reports GitHub's definitive 403 or 404 for the alerts listing: alerts
// off, or no access. Rate limits are checked before this.
func refused(err error) bool {
	errResp, ok := errors.AsType[*ghsdk.ErrorResponse](err)
	if !ok || errResp.Response == nil {
		return false
	}

	return errResp.Response.StatusCode == http.StatusForbidden || errResp.Response.StatusCode == http.StatusNotFound
}

// advisoriesFor answers a repo's advisories from the cache when fresh, else
// reads them. A definitive answer (known, or unknown for 403/404) replaces
// whatever was cached. A failed or rate-limited read keeps the last answer, so
// it never turns a known count into unknown or zero, and waits advisoriesRetry
// before asking again. With nothing cached it answers unknown.
func (c *Client) advisoriesFor(ctx context.Context, owner, name, repoURL string) *dashboard.Advisories {
	key := owner + "/" + name
	old, fresh, have := c.advisories.get(key)
	if fresh {
		return &old
	}
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)
	v, err := c.ReadAdvisories(ctx, owner, name, repoURL)
	if err != nil {
		if errors.Is(err, errAdvisoriesThrottled) {
			slog.Debug("dependency advisories throttled", "forge", dashboard.ForgeGitHub, "repo", key)
		} else {
			slog.Warn("dependency advisories read failed", "forge", dashboard.ForgeGitHub, "repo", key, "error", err)
		}
		if !have {
			old = *dashboard.UnknownAdvisories()
		}
		c.advisories.put(key, old, advisoriesRetry)

		return &old
	}
	c.advisories.put(key, v, advisoriesTTL)

	return &v
}

// advisoriesForAll reads advisories for every tracked repo, bounded
// concurrently, keyed by "owner/name".
func (c *Client) advisoriesForAll(ctx context.Context, repos []graphqlRepo) map[string]*dashboard.Advisories {
	result := make(map[string]*dashboard.Advisories, len(repos))
	var mu sync.Mutex
	sem := make(chan struct{}, dashboard.DefaultMaxConcurrency)
	var wg sync.WaitGroup
	for _, r := range repos {
		wg.Add(1)
		go func(r graphqlRepo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			v := c.advisoriesFor(ctx, r.Owner.Login, r.Name, r.URL)
			mu.Lock()
			result[r.Owner.Login+"/"+r.Name] = v
			mu.Unlock()
		}(r)
	}
	wg.Wait()

	return result
}
