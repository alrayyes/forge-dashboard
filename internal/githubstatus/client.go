// Package githubstatus reads GitHub's public status page, so an unreachable
// GitHub forge can say whether GitHub itself reports an incident (#3633).
//
// The page is an Atlassian Statuspage with a JSON API that needs no
// authentication. The request carries nothing about the user, their account or
// their repos, and is made only when a GitHub call has already failed.
package githubstatus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// BaseURL is GitHub's status page.
const BaseURL = "https://www.githubstatus.com"

const (
	// cacheFor is how long an answer, or a failure to get one, is reused, so a
	// burst of failing calls makes one request.
	cacheFor       = time.Minute
	requestTimeout = 5 * time.Second
	maxBody        = 1 << 20
)

// usedComponents are the GitHub components this dashboard depends on. An
// outage of any other (Codespaces, say) is not a reason its calls fail.
var usedComponents = []string{"API Requests", "Pull Requests", "Actions", "Webhooks"}

var errStatus = errors.New("summary answered with an error status")

// Client reads the summary feed. Safe for concurrent use.
type Client struct {
	baseURL string
	http    *http.Client
	now     func() time.Time
	log     *slog.Logger

	mu       sync.Mutex
	fetched  time.Time
	have     bool
	status   *dashboard.ProviderStatus
	failing  bool
	inflight *flight
}

// Option tunes a Client; the package's tests use them.
type Option func(*Client)

// WithClock sets the time the cache runs by.
func WithClock(now func() time.Time) Option { return func(c *Client) { c.now = now } }

// WithLogger sets where a feed failure is logged.
func WithLogger(l *slog.Logger) Option { return func(c *Client) { c.log = l } }

// New returns a Client for the status page at baseURL; a nil hc uses a plain
// client that doesn't follow redirects, so the one request can't be sent on to
// another host.
func New(baseURL string, hc *http.Client, opts ...Option) *Client {
	if hc == nil {
		hc = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	c := &Client{baseURL: strings.TrimRight(baseURL, "/"), http: hc, now: time.Now, log: slog.Default()}
	for _, o := range opts {
		o(c)
	}

	return c
}

// flight is one fetch in progress; callers that arrive meanwhile wait on it.
type flight struct {
	done   chan struct{}
	status *dashboard.ProviderStatus
}

// ProviderStatus returns what the feed reports about the components in use, or
// nil when it reports nothing there or can't be reached. The answer is reused
// for a minute, a failure included.
//
// The fetch runs on its own context, so a caller that gives up (a closed tab,
// a timeout) neither cancels it nor caches its own cancellation as a failure.
// That caller gets nil; the fetch finishes and the next one finds the answer.
func (c *Client) ProviderStatus(ctx context.Context) *dashboard.ProviderStatus {
	c.mu.Lock()
	if c.have && c.now().Sub(c.fetched) < cacheFor {
		status := c.status
		c.mu.Unlock()

		return status
	}
	f := c.inflight
	if f == nil {
		f = &flight{done: make(chan struct{})}
		c.inflight = f
		go c.run(context.WithoutCancel(ctx), f)
	}
	c.mu.Unlock()

	select {
	case <-f.done:
		return f.status
	case <-ctx.Done():
		return nil
	}
}

// run fetches once, records the outcome and wakes everyone waiting on f.
func (c *Client) run(detached context.Context, f *flight) {
	ctx, cancel := context.WithTimeout(detached, requestTimeout)
	defer cancel()
	status, err := c.fetch(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		// Said once per run of failures, not once per minute.
		if !c.failing {
			c.log.Warn("GitHub status page unreadable", "error", err)
		}
		c.failing = true
		status = nil
	} else {
		c.failing = false
	}
	c.status, c.fetched, c.have = status, c.now(), true
	f.status = status
	c.inflight = nil
	close(f.done)
}

type summary struct {
	Status struct {
		Indicator string `json:"indicator"`
	} `json:"status"`
	Components []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"components"`
	Incidents []struct {
		Name       string `json:"name"`
		Components []struct {
			Name string `json:"name"`
		} `json:"components"`
	} `json:"incidents"`
}

func (c *Client) fetch(ctx context.Context) (*dashboard.ProviderStatus, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v2/summary.json", nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get summary: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: %d", errStatus, resp.StatusCode)
	}
	var s summary
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(&s); err != nil {
		return nil, fmt.Errorf("decode summary: %w", err)
	}

	return relevant(s), nil
}

func used(name string) bool { return slices.Contains(usedComponents, name) }

// relevant keeps the incidents and degraded components that concern what the
// dashboard uses, and nil when there are none.
func relevant(s summary) *dashboard.ProviderStatus {
	out := &dashboard.ProviderStatus{Indicator: s.Status.Indicator}
	for _, comp := range s.Components {
		if comp.Status != "operational" {
			out.Components = addUsed(out.Components, comp.Name)
		}
	}
	for _, inc := range s.Incidents {
		for _, comp := range inc.Components {
			if used(comp.Name) {
				out.Incidents = addOnce(out.Incidents, inc.Name)
				out.Components = addOnce(out.Components, comp.Name)
			}
		}
	}
	if len(out.Incidents) == 0 && len(out.Components) == 0 {
		return nil
	}

	return out
}

func addOnce(list []string, name string) []string {
	if slices.Contains(list, name) {
		return list
	}

	return append(list, name)
}

func addUsed(list []string, name string) []string {
	if !used(name) {
		return list
	}

	return addOnce(list, name)
}
