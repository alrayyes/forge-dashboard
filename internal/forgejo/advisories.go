package forgejo

import (
	"cmp"
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
//
// A failed read is asked again after advisoriesRetry, then after twice that,
// and so on up to advisoriesRetryMax, so an OSV outage isn't answered with a
// listing and a read per repo every five minutes.
const (
	advisoriesTTL      = 15 * time.Minute
	advisoriesRetry    = 5 * time.Minute
	advisoriesRetryMax = 30 * time.Minute
)

// advisoryDeadline bounds one repo's advisory read. It runs inline with the
// repo's CI row, so a slow OSV must not hold that row up: a read that overruns
// is a failed read, answered from the last answer and asked again later. What
// OSV already returned is kept, so the next try gets further.
const advisoryDeadline = 10 * time.Second

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
	calls   map[string]*advisoryCall
	now     func() time.Time
}

type advisoryEntry struct {
	value   dashboard.Advisories
	expires time.Time
	// failures counts the failed reads in a row, for the back-off.
	failures int
	// pkgs are the packages read from the forge, kept when OSV failed so the
	// retry doesn't read the forge again; valid until pkgsUntil.
	pkgs      []osv.Package
	havePkgs  bool
	pkgsUntil time.Time
}

func (c *advisoryCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}

	return time.Now()
}

func (c *advisoryCache) get(repo string) (e advisoryEntry, fresh, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok = c.entries[repo]

	return e, ok && c.clock().Before(e.expires), ok
}

// advisoryCall is one repo's read in flight, shared by everyone who asks for
// the repo meanwhile: a refresh and a webhook-scoped refresh arrive together.
type advisoryCall struct {
	done  chan struct{}
	value dashboard.Advisories
}

// join returns the repo's read in flight, or starts one and says the caller
// is to run it.
func (c *advisoryCache) join(repo string) (call *advisoryCall, leader bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if call, ok := c.calls[repo]; ok {
		return call, false
	}
	if c.calls == nil {
		c.calls = map[string]*advisoryCall{}
	}
	call = &advisoryCall{done: make(chan struct{})}
	c.calls[repo] = call

	return call, true
}

func (c *advisoryCache) finish(repo string, call *advisoryCall) {
	c.mu.Lock()
	delete(c.calls, repo)
	c.mu.Unlock()
	close(call.done)
}

func (c *advisoryCache) put(repo string, e advisoryEntry, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]advisoryEntry{}
	}
	e.expires = c.clock().Add(ttl)
	c.entries[repo] = e
}

// readAdvisories reads a repo's advisories from the lockfiles in the root of
// its default branch (package-lock.json and go.mod), matched against OSV, or
// starting from packages already read from the forge when known is set. Costs
// one listing of the root plus one read per lockfile found. It returns the
// packages it read so a caller can keep them when OSV fails.
//
// A repo with no lockfile it can read is unknown, never zero. So is one where
// any lockfile is too big to read or fails to parse, since the others alone
// would read as the whole answer, and one that matches more advisories than a
// scan reads. A failed call to the forge or to OSV is an error. The package
// names and versions in the lockfiles are sent to OSV; nothing else is.
func (c *Client) readAdvisories(ctx context.Context, owner, name string, known []osv.Package) (dashboard.Advisories, []osv.Package, error) {
	if c.advisoryScanner == nil {
		return dashboard.Advisories{}, nil, errNoAdvisoryScanner
	}
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)

	pkgs := known
	if pkgs == nil {
		got, answer, err := c.lockfilePackages(ctx, owner, name)
		if err != nil || answer != nil {
			if answer != nil {
				return *answer, nil, nil
			}

			return dashboard.Advisories{}, nil, err
		}
		pkgs = got
	}

	sum, err := c.advisoryScanner.Scan(ctx, pkgs)
	switch {
	case errors.Is(err, osv.ErrTooMany):
		return dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonTooMany}, nil, nil
	case err != nil:
		return dashboard.Advisories{}, pkgs, fmt.Errorf("forgejo: match lockfile against OSV: %w", err)
	}

	return dashboard.Advisories{
		State: dashboard.AdvisoriesKnown, Count: sum.Count, Highest: dashboard.AdvisorySeverity(sum.Highest),
	}, nil, nil
}

// lockfilePackages reads the packages in the root lockfiles. When the answer
// is already settled without asking OSV (no lockfile, or one that can't be
// read in full) it returns that answer instead.
func (c *Client) lockfilePackages(ctx context.Context, owner, name string) ([]osv.Package, *dashboard.Advisories, error) {
	repo := owner + "/" + name
	files, skipped, err := c.rootLockfiles(ctx, owner, name)
	if err != nil {
		return nil, nil, err
	}
	if len(skipped) > 0 {
		slog.Warn("lockfile too big to read", "forge", dashboard.ForgeForgejo, "repo", repo, "files", skipped)

		return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
	}
	if len(files) == 0 {
		return nil, dashboard.UnknownAdvisories(), nil
	}

	var pkgs []osv.Package
	for _, file := range files {
		data, err := c.rawFile(ctx, owner, name, file)
		if err != nil {
			return nil, nil, err
		}
		got, err := lockfileReaders[file](data)
		if err != nil {
			slog.Warn("lockfile unreadable", "forge", dashboard.ForgeForgejo, "repo", repo, "file", file, "error", err)

			return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
		}
		pkgs = append(pkgs, got...)
	}
	if pkgs == nil {
		pkgs = []osv.Package{} // read, and empty: not "not read yet"
	}

	return pkgs, nil, nil
}

// rootLockfiles lists the lockfiles in the root of the default branch: the ones
// small enough to read, and the names of the ones that are not.
func (c *Client) rootLockfiles(ctx context.Context, owner, name string) (files, skipped []string, err error) {
	path := fmt.Sprintf("/repos/%s/%s/contents", url.PathEscape(owner), url.PathEscape(name))
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	var entries []struct {
		Name string `json:"name"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	}
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, nil, fmt.Errorf("forgejo: read %s: %w", path, err)
	}
	for _, e := range entries {
		if _, ok := lockfileReaders[e.Name]; !ok || e.Type != "file" {
			continue
		}
		if e.Size > maxLockfileBytes {
			skipped = append(skipped, e.Name)
		} else {
			files = append(files, e.Name)
		}
	}

	return files, skipped, nil
}

// rawFile reads one file of the default branch.
func (c *Client) rawFile(ctx context.Context, owner, name, file string) ([]byte, error) {
	path := fmt.Sprintf("/repos/%s/%s/raw/%s", url.PathEscape(owner), url.PathEscape(name), url.PathEscape(file))
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}

	return body, nil
}

// advisoriesFor answers a repo's advisories from the cache when fresh, else
// reads them within advisoryDeadline. A failed read keeps the last answer, so
// it never turns a known count into unknown or zero, and is asked again after
// a back-off that grows with each failure in a row; the packages already read
// from the forge are kept for that retry. A lockfile that can't be read in full
// is asked again after advisoriesRetry, since the repo may fix it. With nothing
// cached a failure answers unknown. Without a scanner the answer is unknown,
// with the reason that advisories are not enabled.
func (c *Client) advisoriesFor(ctx context.Context, repo dashboard.RepoRef) *dashboard.Advisories {
	if c.advisoryScanner == nil {
		return &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonNotEnabled}
	}
	old, fresh, have := c.advisories.get(repo.FullName)
	if fresh {
		return &old.value
	}
	call, leader := c.advisories.join(repo.FullName)
	if !leader {
		select {
		case <-call.done:
			return &call.value
		case <-ctx.Done():
			return &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
		}
	}
	defer c.advisories.finish(repo.FullName, call)
	call.value = *c.refreshAdvisories(ctx, repo, old, have)

	return &call.value
}

// refreshAdvisories reads a repo's advisories again and remembers the answer.
func (c *Client) refreshAdvisories(ctx context.Context, repo dashboard.RepoRef, old advisoryEntry, have bool) *dashboard.Advisories {
	var known []osv.Package
	if old.havePkgs && c.advisories.clock().Before(old.pkgsUntil) {
		known = old.pkgs
	}
	deadline := cmp.Or(c.advisoryDeadline, advisoryDeadline)
	readCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	v, pkgs, err := c.readAdvisories(readCtx, repo.Owner, repo.Name, known)
	if err != nil {
		slog.Warn("dependency advisories read failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "error", err)
		e := advisoryEntry{value: old.value, failures: old.failures + 1}
		if !have {
			e.value = dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
		}
		switch {
		case known != nil:
			e.pkgs, e.havePkgs, e.pkgsUntil = old.pkgs, true, old.pkgsUntil
		case pkgs != nil:
			e.pkgs, e.havePkgs, e.pkgsUntil = pkgs, true, c.advisories.clock().Add(advisoriesTTL)
		}
		c.advisories.put(repo.FullName, e, min(advisoriesRetry<<min(e.failures-1, 6), advisoriesRetryMax))

		return &e.value
	}
	ttl := advisoriesTTL
	if v.State == dashboard.AdvisoriesUnknown && v.Reason == dashboard.ReasonFailed {
		ttl = advisoriesRetry
	}
	c.advisories.put(repo.FullName, advisoryEntry{value: v}, ttl)

	return &v
}
