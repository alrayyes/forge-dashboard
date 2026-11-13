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

	mu      sync.Mutex
	fetched time.Time
	have    bool
	status  *dashboard.ProviderStatus
	failing bool
}

// Option tunes a Client; the package's tests use them.
type Option func(*Client)

// WithClock sets the time the cache runs by.
func WithClock(now func() time.Time) Option { return func(c *Client) { c.now = now } }

// WithLogger sets where a feed failure is logged.
func WithLogger(l *slog.Logger) Option { return func(c *Client) { c.log = l } }

// New returns a Client for the status page at baseURL; a nil hc uses a plain
// client.
func New(baseURL string, hc *http.Client, opts ...Option) *Client {
	if hc == nil {
		hc = &http.Client{}
	}
	c := &Client{baseURL: strings.TrimRight(baseURL, "/"), http: hc, now: time.Now, log: slog.Default()}
	for _, o := range opts {
		o(c)
	}

	return c
}

// ProviderStatus returns what the feed reports about the components in use, or
// nil when it reports nothing there or can't be reached. The answer is reused
// for a minute, a failure included.
func (c *Client) ProviderStatus(ctx context.Context) *dashboard.ProviderStatus {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.have && c.now().Sub(c.fetched) < cacheFor {
		return c.status
	}
	status, err := c.fetch(ctx)
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

	return status
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
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

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
