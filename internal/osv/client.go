package osv

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
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
	// MaxPackages bounds the distinct packages one scan asks about, so a huge
	// or hostile lockfile can't cost dozens of batches times maxPages pages.
	// Past it the scan fails with ErrTooMany.
	MaxPackages = 3000
	// maxRecordIDs bounds the advisory ids whose records are fetched before they
	// are grouped by alias, which is what keeps the calls bounded; the count
	// against maxAdvisories is taken after grouping.
	maxRecordIDs = 600
	// RecordTTL is how long an advisory's record is reused. A later withdrawal,
	// severity or alias shows up after it.
	RecordTTL = 15 * time.Minute
	// maxCachedRecords bounds the record cache.
	maxCachedRecords = 5000
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

	sem chan struct{}
	now func() time.Time

	mu       sync.Mutex
	records  map[string]cachedRecord
	inflight map[string]*flight
}

type cachedRecord struct {
	rec     record
	expires time.Time
}

// SetClock replaces the clock the record cache expires by. For tests.
func (c *Client) SetClock(now func() time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
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

	return &Client{
		base: strings.TrimSuffix(base, "/"), http: httpClient, records: map[string]cachedRecord{},
		inflight: map[string]*flight{}, sem: make(chan struct{}, detailConcurrency), now: time.Now,
	}
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
	pkgs = distinct(pkgs)
	if len(pkgs) > MaxPackages {
		return Summary{}, ErrTooMany
	}
	ids := map[string]struct{}{}
	for start := 0; start < len(pkgs); start += batchSize {
		end := min(start+batchSize, len(pkgs))
		if err := c.queryBatch(ctx, pkgs[start:end], ids); err != nil {
			return Summary{}, err
		}
	}
	if len(ids) > maxRecordIDs {
		return Summary{}, ErrTooMany
	}

	recs, err := c.loadRecords(ctx, ids)
	if err != nil {
		return Summary{}, err
	}

	sum := summarise(recs)
	if sum.Count > maxAdvisories {
		return Summary{}, ErrTooMany
	}

	return sum, nil
}

// distinct drops repeats of one package: a lockfile lists the same name and
// version once per place it is installed.
func distinct(pkgs []Package) []Package {
	seen := make(map[Package]struct{}, len(pkgs))
	out := make([]Package, 0, len(pkgs))
	for _, p := range pkgs {
		if _, ok := seen[p]; !ok {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}

	return out
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

// loadRecords returns the record of every id, fetching the ones not held with
// at most detailConcurrency workers. The first error stops the rest, so an OSV
// that is failing doesn't cost a call per advisory.
func (c *Client) loadRecords(ctx context.Context, ids map[string]struct{}) (map[string]record, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	todo := make(chan string)
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		firstErr error
		out      = make(map[string]record, len(ids))
	)
	for range min(detailConcurrency, len(ids)) {
		wg.Go(func() {
			for id := range todo {
				r, err := c.record(ctx, id)
				mu.Lock()
				if err != nil {
					firstErr = cmp.Or(firstErr, err)
					cancel()
				} else {
					out[id] = r
				}
				mu.Unlock()
			}
		})
	}
	feed(ctx, todo, ids)
	wg.Wait()
	if firstErr != nil {
		return nil, fmt.Errorf("osv: read advisory records: %w", firstErr)
	}
	if err := ctx.Err(); err != nil && len(out) < len(ids) {
		return nil, fmt.Errorf("osv: read advisory records: %w", err)
	}

	return out, nil
}

// feed hands the ids to the workers until they are all taken or ctx ends.
func feed(ctx context.Context, todo chan<- string, ids map[string]struct{}) {
	defer close(todo)
	for id := range ids {
		select {
		case todo <- id:
		case <-ctx.Done():
			return
		}
	}
}

func isContextErr(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// flight is one record fetch that callers asking for the same id share.
type flight struct {
	done chan struct{}
	rec  record
	err  error
}

// record returns an advisory's record from the cache while it is fresh, else
// fetches it. Scans of different repos run in parallel and meet the same ids on
// a cold start, so one fetch serves them all, and at most detailConcurrency
// fetches are in flight across the client.
func (c *Client) record(ctx context.Context, id string) (record, error) {
	for {
		c.mu.Lock()
		if e, ok := c.records[id]; ok && c.now().Before(e.expires) {
			c.mu.Unlock()

			return e.rec, nil
		}
		f, ok := c.inflight[id]
		if !ok {
			break // still holding c.mu: this caller fetches
		}
		c.mu.Unlock()
		select {
		case <-f.done:
		case <-ctx.Done():
			return record{}, fmt.Errorf("osv: wait for advisory record: %w", ctx.Err())
		}
		// The fetch's own scan may have been cut short; that is its deadline,
		// not an answer about the record, so go round and fetch with ours.
		if f.err == nil || !isContextErr(f.err) || ctx.Err() != nil {
			return f.rec, f.err
		}
	}
	f := &flight{done: make(chan struct{})}
	c.inflight[id] = f
	c.mu.Unlock()

	f.rec, f.err = c.fetchLimited(ctx, id)

	c.mu.Lock()
	delete(c.inflight, id)
	if f.err == nil {
		c.remember(id, f.rec)
	}
	c.mu.Unlock()
	close(f.done)

	return f.rec, f.err
}

func (c *Client) fetchLimited(ctx context.Context, id string) (record, error) {
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return record{}, fmt.Errorf("osv: wait to fetch advisory record: %w", ctx.Err())
	}

	return c.fetchRecord(ctx, id)
}

// remember keeps a record for RecordTTL. Past maxCachedRecords it drops the
// expired ones first, and everything if that is not enough, so the cache can't
// grow without bound. The caller holds c.mu.
func (c *Client) remember(id string, r record) {
	if len(c.records) >= maxCachedRecords {
		for k, e := range c.records {
			if !c.now().Before(e.expires) {
				delete(c.records, k)
			}
		}
		if len(c.records) >= maxCachedRecords {
			clear(c.records)
		}
	}
	c.records[id] = cachedRecord{rec: r, expires: c.now().Add(RecordTTL)}
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

// sets is a union-find over advisory ids.
type sets map[string]string

func (s sets) find(x string) string {
	for {
		p, ok := s[x]
		if !ok || p == x {
			s[x] = x

			return x
		}
		x = p
	}
}

// aliasRoots maps each live (not withdrawn) record to a representative of the
// set of records it shares an alias with. Every record is joined to all of its
// aliases, fetched or not, so two records that name the same CVE are one
// advisory even when neither lists the other.
func aliasRoots(recs map[string]record) map[string]string {
	groups := sets{}
	for id, r := range recs {
		if r.withdrawn {
			continue
		}
		for _, a := range r.aliases {
			if other, ok := recs[a]; ok && other.withdrawn {
				continue
			}
			groups[groups.find(a)] = groups.find(id)
		}
	}
	roots := map[string]string{}
	for id, r := range recs {
		if !r.withdrawn {
			roots[id] = groups.find(id)
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
	slog.Debug("osv request", "method", method, "url", c.base+path)
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
