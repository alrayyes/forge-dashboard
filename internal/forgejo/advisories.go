package forgejo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/osv"
)

// advisoriesTTL and advisoriesRetry match the GitHub source: an answer is reused
// for fifteen minutes, a failed read is asked again after five. Dependencies
// change on the scale of hours, and a webhook-scoped refresh would otherwise
// read the lockfile again for every finished run.
const (
	advisoriesTTL   = 15 * time.Minute
	advisoriesRetry = 5 * time.Minute
)

// maxLockfileBytes is the largest lockfile read. A bigger one is left alone and
// the repo reads as unknown.
const maxLockfileBytes = 8 << 20

var errNoAdvisoryScanner = errors.New("forgejo: no advisory scanner configured")

// AdvisoryScanner matches packages against a vulnerability database. osv.Client
// is the real one; a test stands in with its own.
type AdvisoryScanner interface {
	Scan(ctx context.Context, pkgs []osv.Package) (osv.Summary, error)
}

// lockfileReaders are the files in a repo's root that list its pinned
// dependencies, with the reader for each.
var lockfileReaders = map[string]func([]byte) ([]osv.Package, error){
	"package-lock.json": osv.ParsePackageLock,
	"go.mod":            osv.ParseGoMod,
}

// SetAdvisoryScanner turns on advisories for this client's repos: with a
// scanner set, ReadMainBranch reads the default branch's lockfiles and asks the
// scanner about the packages in them. Without one, rows carry no advisories.
// Call it right after construction, before the client makes a request.
func (c *Client) SetAdvisoryScanner(s AdvisoryScanner) {
	c.advisoryScanner = s
}

// advisoryCache remembers each repo's last answer and when to ask again.
type advisoryCache struct {
	mu      sync.Mutex
	entries map[string]advisoryEntry
}

type advisoryEntry struct {
	value   dashboard.Advisories
	expires time.Time
}

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

func (c *advisoryCache) expireAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.entries {
		e.expires = time.Time{}
		c.entries[k] = e
	}
}

// ReadAdvisories implements dashboard.AdvisoryReader from the lockfiles in the
// root of owner/name's default branch (package-lock.json and go.mod), matched
// against OSV. Costs one listing of the root plus one read per lockfile found.
//
// A repo with no lockfile it can read is unknown, never zero, and so is one
// whose lockfile fails to parse or matches more advisories than a scan reads.
// A failed call to the forge or to OSV is an error. The package names and
// versions in the lockfiles are sent to OSV; nothing else is.
func (c *Client) ReadAdvisories(ctx context.Context, owner, name, _ string) (dashboard.Advisories, error) {
	if c.advisoryScanner == nil {
		return dashboard.Advisories{}, errNoAdvisoryScanner
	}
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)

	var pkgs []osv.Package
	found := false
	files, err := c.rootLockfiles(ctx, owner, name)
	if err != nil {
		return dashboard.Advisories{}, err
	}
	for _, file := range files {
		data, err := c.rawFile(ctx, owner, name, file)
		if err != nil {
			return dashboard.Advisories{}, err
		}
		got, err := lockfileReaders[file](data)
		if err != nil {
			slog.Warn("lockfile unreadable", "forge", dashboard.ForgeForgejo, "repo", owner+"/"+name, "file", file, "error", err)

			return dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
		}
		pkgs = append(pkgs, got...)
		found = true
	}
	if !found {
		return *dashboard.UnknownAdvisories(), nil
	}

	sum, err := c.advisoryScanner.Scan(ctx, pkgs)
	switch {
	case errors.Is(err, osv.ErrTooMany):
		return dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonTooMany}, nil
	case err != nil:
		return dashboard.Advisories{}, fmt.Errorf("forgejo: match lockfile against OSV: %w", err)
	}

	return dashboard.Advisories{
		State: dashboard.AdvisoriesKnown, Count: sum.Count, Highest: dashboard.AdvisorySeverity(sum.Highest),
	}, nil
}

// rootLockfiles lists the lockfiles in the root of the default branch that are
// small enough to read.
func (c *Client) rootLockfiles(ctx context.Context, owner, name string) ([]string, error) {
	path := fmt.Sprintf("/repos/%s/%s/contents", url.PathEscape(owner), url.PathEscape(name))
	body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusNotFound {
			return nil, nil // an empty repo has no root to list
		}

		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	var entries []struct {
		Name string `json:"name"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	}
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("forgejo: read %s: %w", path, err)
	}
	var out []string
	for _, e := range entries {
		if _, ok := lockfileReaders[e.Name]; ok && e.Type == "file" && e.Size <= maxLockfileBytes {
			out = append(out, e.Name)
		}
	}

	return out, nil
}

// rawFile reads one file of the default branch.
func (c *Client) rawFile(ctx context.Context, owner, name, file string) ([]byte, error) {
	path := fmt.Sprintf("/repos/%s/%s/raw/%s", url.PathEscape(owner), url.PathEscape(name), url.PathEscape(file))
	body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}

	return body, nil
}

// advisoriesFor answers a repo's advisories from the cache when fresh, else
// reads them. A failed read keeps the last answer, so it never turns a known
// count into unknown or zero, and is asked again after advisoriesRetry. With
// nothing cached it answers unknown. It returns nil when no scanner is set.
func (c *Client) advisoriesFor(ctx context.Context, repo dashboard.RepoRef) *dashboard.Advisories {
	if c.advisoryScanner == nil {
		return nil
	}
	old, fresh, have := c.advisories.get(repo.FullName)
	if fresh {
		return &old
	}
	v, err := c.ReadAdvisories(ctx, repo.Owner, repo.Name, repo.URL)
	if err != nil {
		slog.Warn("dependency advisories read failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "error", err)
		if !have {
			old = dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
		}
		c.advisories.put(repo.FullName, old, advisoriesRetry)

		return &old
	}
	c.advisories.put(repo.FullName, v, advisoriesTTL)

	return &v
}
