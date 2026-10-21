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

// advisoriesTTL is how long a repo's advisory answer is reused. Alerts change
// on the scale of hours, and a webhook-scoped refresh would otherwise ask again
// for every finished check.
const advisoriesTTL = 15 * time.Minute

// maxAlertPages bounds the pages read for one repo: 100 alerts a page, so a repo
// past this still reads as a large count rather than costing unbounded calls.
const maxAlertPages = 10

// dependabotAlertLister is the one go-github call the advisory read needs,
// behind an interface of our own so a test or another SDK can stand in.
type dependabotAlertLister interface {
	ListRepoAlerts(ctx context.Context, owner, repo string, opts *ghsdk.ListAlertsOptions) ([]*ghsdk.DependabotAlert, *ghsdk.Response, error)
}

// advisoryCache remembers each repo's last advisory answer.
type advisoryCache struct {
	mu      sync.Mutex
	entries map[string]advisoryEntry
}

type advisoryEntry struct {
	value   dashboard.Advisories
	fetched time.Time
}

func (c *advisoryCache) get(repo string, fresh bool) (dashboard.Advisories, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[repo]
	if !ok || (fresh && time.Since(e.fetched) >= advisoriesTTL) {
		return dashboard.Advisories{}, false
	}

	return e.value, true
}

func (c *advisoryCache) put(repo string, v dashboard.Advisories) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]advisoryEntry{}
	}
	c.entries[repo] = advisoryEntry{value: v, fetched: time.Now()}
}

// ReadAdvisories implements dashboard.AdvisoryReader from the repository's open
// Dependabot alerts (GET /repos/{owner}/{repo}/dependabot/alerts?state=open).
// GitHub answers 404 where alerts are switched off and 403 where the token
// lacks the security_events scope (or the Dependabot alerts permission); both
// are "unknown", never a zero count.
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
		if resp.NextPage == 0 {
			break
		}
		opts.ListOptions.Page = resp.NextPage
	}
	if out.Count > 0 {
		out.URL = repoURL + "/security/dependabot"
	}

	return out, nil
}

// refused reports GitHub's 403 or 404 for the alerts listing.
func refused(err error) bool {
	if errResp, ok := errors.AsType[*ghsdk.ErrorResponse](err); ok && errResp.Response != nil {
		return errResp.Response.StatusCode == http.StatusForbidden || errResp.Response.StatusCode == http.StatusNotFound
	}
	if _, ok := errors.AsType[*ghsdk.RateLimitError](err); ok {
		return true
	}

	return false
}

// advisoriesFor answers a repo's advisories from the cache when fresh, else
// reads them. A failed read keeps the last answer if there is one and is
// unknown otherwise, so a flaky call never shows as zero.
func (c *Client) advisoriesFor(ctx context.Context, owner, name, repoURL string) *dashboard.Advisories {
	key := owner + "/" + name
	if v, ok := c.advisories.get(key, true); ok {
		return &v
	}
	v, err := c.ReadAdvisories(ctx, owner, name, repoURL)
	if err != nil {
		slog.Warn("dependency advisories read failed", "forge", dashboard.ForgeGitHub, "repo", key, "error", err)
		if old, ok := c.advisories.get(key, false); ok {
			return &old
		}

		return dashboard.UnknownAdvisories()
	}
	c.advisories.put(key, v)

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
