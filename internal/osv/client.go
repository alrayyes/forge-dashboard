package osv

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const httpTimeout = 30 * time.Second

// BaseURL is OSV's public API.
const BaseURL = "https://api.osv.dev"

const (
	// batchSize is how many packages one querybatch call asks about. OSV
	// accepts at most 1000 queries in a batch.
	batchSize = 500
	// maxAdvisories bounds the distinct advisories one scan reads the record
	// of, so one badly out of date repo can't cost hundreds of calls. Past it
	// the scan fails with ErrTooMany rather than report a count that stops short.
	maxAdvisories = 300
	// maxPages bounds the pages followed for one package's matches.
	maxPages = 5
	// detailConcurrency is how many advisory records are fetched at once.
	detailConcurrency = 8
	// maxResponseBytes caps what is read from one OSV answer.
	maxResponseBytes = 16 << 20
)

// ErrTooMany is a scan that matched more advisories than maxAdvisories.
var ErrTooMany = errors.New("osv: too many advisories to read")

var (
	errBatchShape = errors.New("osv: querybatch answered a different number of results than queries")
	errStatus     = errors.New("osv: unexpected status")
)

// Summary is what a scan found: how many distinct advisories match, and the
// worst severity among them ("low", "medium", "high" or "critical"), empty when
// there are none or none carries a severity the scan can read.
type Summary struct {
	Count   int
	Highest string
}

// Client queries an OSV API. It sends only package names and versions, and
// remembers each advisory's record, which does not change with the repo.
type Client struct {
	base string
	http *http.Client

	mu      sync.Mutex
	records map[string]record
}

// record is the part of an advisory's OSV record a scan uses.
type record struct {
	aliases   []string
	severity  string
	withdrawn bool
}

// NewClient returns a Client against base (BaseURL for the public API). A nil
// httpClient gets one with a timeout.
func NewClient(base string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: httpTimeout}
	}

	return &Client{base: strings.TrimSuffix(base, "/"), http: httpClient, records: map[string]record{}}
}

type query struct {
	Version   string       `json:"version"`
	Package   queryPackage `json:"package"`
	PageToken string       `json:"page_token,omitempty"`
}

type queryPackage struct {
	Name      string `json:"name"`
	Ecosystem string `json:"ecosystem"`
}

type batchResult struct {
	Vulns         []struct{ ID string } `json:"vulns"`
	NextPageToken string                `json:"next_page_token"`
}

// Scan matches pkgs against OSV and summarises the advisories found. An empty
// list of packages is a clean scan. Any failed call is an error, since a
// partial answer would read as fewer advisories than there are.
func (c *Client) Scan(ctx context.Context, pkgs []Package) (Summary, error) {
	ids := map[string]struct{}{}
	for start := 0; start < len(pkgs); start += batchSize {
		end := min(start+batchSize, len(pkgs))
		if err := c.queryBatch(ctx, pkgs[start:end], ids); err != nil {
			return Summary{}, err
		}
	}
	if len(ids) > maxAdvisories {
		return Summary{}, ErrTooMany
	}

	recs, err := c.loadRecords(ctx, ids)
	if err != nil {
		return Summary{}, err
	}

	return summarise(recs), nil
}

// queryBatch asks about pkgs, following each package's page tokens, and adds
// the advisory ids it finds to ids.
func (c *Client) queryBatch(ctx context.Context, pkgs []Package, ids map[string]struct{}) error {
	queries := make([]query, len(pkgs))
	for i, p := range pkgs {
		queries[i] = query{Version: p.Version, Package: queryPackage{Name: p.Name, Ecosystem: p.Ecosystem}}
	}
	for range maxPages {
		var resp struct {
			Results []batchResult `json:"results"`
		}
		if err := c.do(ctx, http.MethodPost, "/v1/querybatch", map[string]any{"queries": queries}, &resp); err != nil {
			return err
		}
		if len(resp.Results) != len(queries) {
			return fmt.Errorf("%w: %d results for %d queries", errBatchShape, len(resp.Results), len(queries))
		}
		next := collect(queries, resp.Results, ids)
		if len(next) == 0 {
			return nil
		}
		queries = next
	}

	return ErrTooMany
}

// collect adds the ids in results to ids and returns the queries that have a
// further page.
func collect(queries []query, results []batchResult, ids map[string]struct{}) []query {
	var next []query
	for i, r := range results {
		for _, v := range r.Vulns {
			ids[v.ID] = struct{}{}
		}
		if r.NextPageToken != "" {
			q := queries[i]
			q.PageToken = r.NextPageToken
			next = append(next, q)
		}
	}

	return next
}

// loadRecords returns the record of every id, fetching the ones not yet remembered.
func (c *Client) loadRecords(ctx context.Context, ids map[string]struct{}) (map[string]record, error) {
	out := make(map[string]record, len(ids))
	var missing []string
	c.mu.Lock()
	for id := range ids {
		if r, ok := c.records[id]; ok {
			out[id] = r
		} else {
			missing = append(missing, id)
		}
	}
	c.mu.Unlock()

	var (
		wg       sync.WaitGroup
		outMu    sync.Mutex
		firstErr error
	)
	sem := make(chan struct{}, detailConcurrency)
	for _, id := range missing {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			r, err := c.fetchRecord(ctx, id)
			outMu.Lock()
			defer outMu.Unlock()
			if err != nil {
				firstErr = cmp.Or(firstErr, err)

				return
			}
			out[id] = r
			c.mu.Lock()
			c.records[id] = r
			c.mu.Unlock()
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, fmt.Errorf("osv: read advisory records: %w", firstErr)
	}

	return out, nil
}

func (c *Client) fetchRecord(ctx context.Context, id string) (record, error) {
	var v struct {
		Aliases          []string `json:"aliases"`
		Withdrawn        string   `json:"withdrawn"`
		DatabaseSpecific struct {
			Severity string `json:"severity"`
		} `json:"database_specific"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/vulns/"+url.PathEscape(id), nil, &v); err != nil {
		return record{}, err
	}

	return record{aliases: v.Aliases, withdrawn: v.Withdrawn != "", severity: normaliseSeverity(v.DatabaseSpecific.Severity)}, nil
}

// normaliseSeverity maps the word GitHub's advisory database writes into an
// OSV record ("LOW", "MODERATE", "HIGH", "CRITICAL") to the dashboard's four
// levels. Anything else, including a record that only carries a CVSS vector,
// is no severity: the advisory still counts.
func normaliseSeverity(s string) string {
	switch strings.ToLower(s) {
	case "low":
		return "low"
	case "moderate", "medium":
		return "medium"
	case "high":
		return "high"
	case "critical":
		return "critical"
	default:
		return ""
	}
}

var severityRank = map[string]int{"low": 1, "medium": 2, "high": 3, "critical": 4}

// summarise counts the advisories once each: records that list one another as
// aliases (a GHSA and its PYSEC twin) are the same advisory, and its severity is
// the highest any of them states.
func summarise(recs map[string]record) Summary {
	groups := map[string]string{} // group root -> highest severity in it
	for id, root := range aliasRoots(recs) {
		if severityRank[recs[id].severity] >= severityRank[groups[root]] {
			groups[root] = recs[id].severity
		}
	}
	out := Summary{Count: len(groups)}
	for _, sev := range groups {
		if severityRank[sev] > severityRank[out.Highest] {
			out.Highest = sev
		}
	}

	return out
}

// aliasRoots maps each live (not withdrawn) record to a representative of the
// set of records it shares an alias with.
func aliasRoots(recs map[string]record) map[string]string {
	parent := map[string]string{}
	find := func(x string) string {
		for {
			p, ok := parent[x]
			if !ok || p == x {
				parent[x] = x

				return x
			}
			x = p
		}
	}
	live := func(id string) bool {
		r, ok := recs[id]

		return ok && !r.withdrawn
	}
	for id, r := range recs {
		for _, a := range r.aliases {
			if live(id) && live(a) {
				parent[find(a)] = find(id)
			}
		}
	}
	roots := map[string]string{}
	for id := range recs {
		if live(id) {
			roots[id] = find(id)
		}
	}

	return roots
}

func (c *Client) do(ctx context.Context, method, path string, body, into any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("osv: encode request: %w", err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return fmt.Errorf("osv: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("osv: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: %s %s: %s", errStatus, method, path, resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(into); err != nil {
		return fmt.Errorf("osv: read %s: %w", path, err)
	}

	return nil
}
