package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/advisorycache"
	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// maxAlertPages bounds the pages read for one repo: 100 alerts a page. A repo
// with more open alerts than that reads as unknown rather than as a count that
// stops short of the truth.
const maxAlertPages = 10

// errAdvisoriesThrottled marks a read GitHub refused for rate limiting. Unlike
// a 403 for a missing scope it says nothing about the repo, so it never
// replaces an answer already known.
var errAdvisoriesThrottled = errors.New("rate limited")

// advisoryCache remembers each repo's last advisory answer and when to ask again.
type advisoryCache struct {
	cache advisorycache.Cache[advisoryEntry]
	// lists keeps each repo's full list, which the read for the count fills
	// too, so opening the advisories dialog costs no second read.
	lists advisorycache.Lists
}

// AdvisoryCache remembers each repo's advisory answer and list. Share one
// between the clients a source builder makes, since each lives for one request.
type AdvisoryCache = advisoryCache

// NewAdvisoryCache returns an empty cache to share between clients.
func NewAdvisoryCache() *AdvisoryCache { return &advisoryCache{} }

// ShareAdvisoryCache makes this Client remember advisories in cache, so a
// client built later picks up what the old one read. Call it right after
// construction.
func (c *Client) ShareAdvisoryCache(cache *AdvisoryCache) { c.advisories = cache }

type advisoryEntry struct {
	value dashboard.Advisories
	// refusal is the last 403 or 404 logged for this repo, so the same
	// refusal is said once and a changed one is said again. A failed read keeps it.
	refusal string
	// refusals counts how many reads in a row got that same refusal.
	refusals int
}

// get returns the cached answer and whether it is still fresh.
func (c *advisoryCache) get(repo string) (v dashboard.Advisories, fresh, ok bool) {
	e, fresh, ok := c.cache.Get(repo)

	return e.value, fresh, ok
}

// putAnswer stores a definitive answer and forgets any refusal.
func (c *advisoryCache) putAnswer(repo string, v dashboard.Advisories) {
	c.cache.Put(repo, advisoryEntry{value: v}, advisorycache.TTL)
}

// putFailure stores the answer to keep after a failed or throttled read, to be
// retried soon. It leaves the refusal alone: the failure says nothing about it.
func (c *advisoryCache) putFailure(repo string, v dashboard.Advisories) {
	c.cache.Update(repo, func(e advisoryEntry, _ bool) (advisoryEntry, time.Duration) {
		e.value = v

		return e, advisorycache.Retry
	})
}

// putRefusal stores an unknown answer behind a 403 or 404. It returns whether
// this refusal differs from the one stored before, and so is worth logging. The
// first of a kind is asked again soon, since the owner may be fixing the
// permission; the same one again settles at the normal interval, so a repo that
// stays refused costs no more than any other.
func (c *advisoryCache) putRefusal(repo string, v dashboard.Advisories, refusal string) (changed bool) {
	c.cache.Update(repo, func(e advisoryEntry, _ bool) (advisoryEntry, time.Duration) {
		changed = e.refusal != refusal
		ttl := advisorycache.Retry
		if changed {
			e.refusals = 1
		} else {
			e.refusals++
			ttl = advisorycache.TTL
		}
		e.value, e.refusal = v, refusal

		return e, ttl
	})

	return changed
}

// ReadAdvisories implements dashboard.AdvisoryReader from the repository's open
// Dependabot alerts (GET /repos/{owner}/{repo}/dependabot/alerts?state=open),
// following the cursor GitHub pages them by. GitHub answers 404 where alerts
// are switched off and 403 where the token lacks the security_events scope (or
// the Dependabot alerts permission); both are "unknown", never a zero count. So
// is a repo with more alerts than maxAlertPages hold. A rate limit is an error.
func (c *Client) ReadAdvisories(ctx context.Context, owner, name, repoURL string) (dashboard.Advisories, error) {
	v, _, _, err := c.readAlerts(ctx, owner, name, repoURL)

	return v, err
}

// alertsRefusal is what GitHub said when it refused the alerts listing.
type alertsRefusal struct {
	status  int
	message string
}

func (r *alertsRefusal) String() string { return fmt.Sprintf("%d %s", r.status, r.message) }

// readAlerts pages through the repo's open alerts once and shapes what it read
// both ways: the count a row shows and the full list the dialog shows, so one
// read serves both. A refusal or too many alerts is an unknown answer with its
// matching unknown list, and an error is a failed or throttled read.
func (c *Client) readAlerts(ctx context.Context, owner, name, repoURL string) (dashboard.Advisories, dashboard.AdvisoryList, *alertsRefusal, error) {
	list := dashboard.AdvisoryList{State: dashboard.AdvisoriesKnown, Advisories: []dashboard.AdvisoryItem{}}

	after := ""
	for range maxAlertPages {
		alerts, next, err := c.readAlertPage(ctx, owner, name, after)
		if err != nil {
			return alertsFailed(err)
		}
		for i := range alerts {
			list.Advisories = append(list.Advisories, advisoryItemOf(&alerts[i]))
		}
		if next == "" {
			sortAdvisories(list.Advisories)

			return countOf(&list, repoURL), list, nil, nil
		}
		after = next
	}

	tooMany := dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonTooMany}

	return tooMany, unknownAdvisoryList(dashboard.ReasonTooMany), nil, nil
}

// alertsFailed shapes a failed page read as readAlerts answers it: a refusal
// is an unknown answer, anything else an error with the reason its list gets.
func alertsFailed(err error) (dashboard.Advisories, dashboard.AdvisoryList, *alertsRefusal, error) {
	v, refusal, failure := alertsFailure(err)
	if failure == nil {
		return v, unknownAdvisoryList(v.Reason), refusal, nil
	}
	reason := dashboard.ReasonFailed
	if errors.Is(failure, errAdvisoriesThrottled) {
		reason = dashboard.ReasonThrottled
	}

	return v, unknownAdvisoryList(reason), nil, failure
}

// countOf is the row's count over a whole list, and sets the list's own page.
func countOf(list *dashboard.AdvisoryList, repoURL string) dashboard.Advisories {
	out := dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: len(list.Advisories)}
	for i := range list.Advisories {
		if sev := list.Advisories[i].Severity; sev.Rank() > out.Highest.Rank() {
			out.Highest = sev
		}
	}
	if out.Count == 0 {
		return out
	}
	out.URL = repoURL + "/security/dependabot"
	// The repo's alerts page is the folder of an alert's own page, so it follows
	// the forge's host without the client knowing it.
	if first := list.Advisories[0].URL; strings.Contains(first, "/") {
		list.URL = first[:strings.LastIndex(first, "/")]
	}

	return out
}

// alertsFailure maps a failed alerts listing: a definitive refusal is an
// unknown answer, anything else an error.
func alertsFailure(err error) (dashboard.Advisories, *alertsRefusal, error) {
	switch {
	case throttled(err):
		return dashboard.Advisories{}, nil, fmt.Errorf("list dependabot alerts: %w", errAdvisoriesThrottled)
	case refused(err):
		errResp, _ := errors.AsType[*ghsdk.ErrorResponse](err)

		status := errResp.Response.StatusCode
		reason := dashboard.ReasonRefused
		if status == http.StatusNotFound {
			reason = dashboard.ReasonSwitchedOff
		}

		return dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: reason}, &alertsRefusal{status: status, message: errResp.Message}, nil
	default:
		return dashboard.Advisories{}, nil, fmt.Errorf("list dependabot alerts: %w", err)
	}
}

// startAdvisories reads every tracked repo's advisories in the background, so
// the poll's other reads run alongside them. The answer arrives on the channel.
func (c *Client) startAdvisories(ctx context.Context, repos []graphqlRepo) <-chan map[string]*dashboard.Advisories {
	done := make(chan map[string]*dashboard.Advisories, 1)
	go func() { done <- c.advisoriesForAll(ctx, repos) }()

	return done
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

// advisoryKey is what a repo's cached advisories are filed under: the repo and
// the credential that read it, so what one credential could see is never served
// to another (a narrower token, another installation) from the shared cache.
func (c *Client) advisoryKey(owner, name string) string {
	return c.statsCredential + " " + owner + "/" + name
}

// advisoriesFor answers a repo's advisories from the cache when fresh, else
// reads them. A definitive answer (known, or unknown for 403/404) replaces
// whatever was cached. A refusal repeated unchanged waits the full TTL, not the retry delay. A failed or rate-limited read keeps the last answer, so
// it never turns a known count into unknown or zero, and waits advisorycache.Retry
// before asking again. With nothing cached it answers unknown.
func (c *Client) advisoriesFor(ctx context.Context, owner, name, repoURL string) *dashboard.Advisories {
	repo := owner + "/" + name
	key := c.advisoryKey(owner, name)
	old, fresh, have := c.advisories.get(key)
	if fresh {
		return &old
	}
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)
	v, list, refusal, err := c.readAlerts(ctx, owner, name, repoURL)
	if err != nil {
		reason := dashboard.ReasonFailed
		if errors.Is(err, errAdvisoriesThrottled) {
			reason = dashboard.ReasonThrottled
			c.logger().Debug("dependency advisories throttled", "forge", dashboard.ForgeGitHub, "repo", repo)
		} else {
			c.logger().Warn("dependency advisories read failed", "forge", dashboard.ForgeGitHub, "repo", repo, "error", err)
		}
		if !have {
			old = *dashboard.UnknownAdvisories()
		}
		if old.State == dashboard.AdvisoriesUnknown {
			old.Reason = reason
		}
		c.advisories.putFailure(key, old)

		return &old
	}
	if refusal != nil {
		v.ListReadAt = c.advisories.lists.Put(key, list, advisorycache.Retry).ReadAt
		if c.advisories.putRefusal(key, v, refusal.String()) {
			c.logger().Warn("dependency advisories refused", "forge", dashboard.ForgeGitHub, "repo", repo,
				"status", refusal.status, "message", refusal.message)
		}

		return &v
	}
	// A list that says too many is as good as a known one for the TTL: the same
	// alerts give the same answer.
	v.ListReadAt = c.advisories.lists.Put(key, list, advisorycache.TTL).ReadAt
	c.advisories.putAnswer(key, v)

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

// withAdvisories is row with its advisories set.
func withAdvisories(row dashboard.MainBranch, a *dashboard.Advisories) dashboard.MainBranch {
	row.Advisories = a

	return row
}
