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
	"strings"
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

// advisoriesUnreadableRetry is how long a repo whose lock file can't be used
// (too big, fails to parse, nothing in it to check) waits before it is read
// again. Such a file rarely changes, so five minutes would read it and log it
// twelve times an hour for nothing.
//
// advisoriesStaleMax is how long a failed read keeps showing the last count:
// past it the repo reads as unknown, so a number that old can't pass for
// current. maxAdvisoryEntries bounds the cache.
const (
	advisoriesUnreadableRetry = time.Hour
	advisoriesStaleMax        = 24 * time.Hour
	maxAdvisoryEntries        = 5000
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
	"package-lock.json": osv.ParseNPMLock,
	"bun.lock":          osv.ParseBunLock,
	"composer.lock":     osv.ParseComposerLock,
	"poetry.lock":       osv.ParsePoetryLock,
	"uv.lock":           osv.ParseUvLock,
	"Cargo.lock":        osv.ParseCargoLock,
	"go.mod":            osv.ParseGoMod,
}

// SetAdvisoryScanner turns on advisories for this client's repos: with a
// scanner set, ReadMainBranch reads the default branch's lockfiles and asks the
// scanner about the packages in them. Without one, every Forgejo row carries
// the unknown state with the reason that advisories are not enabled, and
// nothing is read or sent. Call it right after construction, before the client
// makes a request.
func (c *Client) SetAdvisoryScanner(s AdvisoryScanner) {
	c.advisoryScanner = s
}

// ShareAdvisoryCache makes this client remember advisories in cache, so a
// client built later over the same forge (every login and settings save builds
// one) picks up the answers, retry timers and failure counts of the old one.
// Without it a client keeps its own. Call it right after construction.
func (c *Client) ShareAdvisoryCache(cache *AdvisoryCache) {
	c.advisories = cache
}

// NewAdvisoryCache returns an empty cache to share between clients.
func NewAdvisoryCache() *AdvisoryCache { return &AdvisoryCache{} }

// AdvisoryCache remembers each repo's last answer and when to ask again. Its
// keys name the instance as well as the repo, so one cache can serve clients
// for different forges.
type AdvisoryCache = advisoryCache

type advisoryCache struct {
	max     int // entries kept; zero means maxAdvisoryEntries
	mu      sync.Mutex
	entries map[string]advisoryEntry
	calls   map[string]*advisoryCall
	now     func() time.Time
}

type advisoryEntry struct {
	value   dashboard.Advisories
	expires time.Time
	// answered is when value was last read successfully, for the age bound.
	answered time.Time
	// unreadable marks a settled unknown answer (a lock file that can't be
	// used), so the warning is logged on the first read and not on every one.
	unreadable bool
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
	// cancelled is set when the leader's read ended only because its own
	// context did: waiters with a live context read for themselves.
	cancelled bool
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
	if len(c.entries) > cmp.Or(c.max, maxAdvisoryEntries) {
		c.evict(repo)
	}
}

// evict makes room: it drops entries that have expired and no longer hold
// packages for a retry, then, if the cache is still over its limit, others,
// keeping the entry just written. Call it with the lock held.
func (c *advisoryCache) evict(keep string) {
	now := c.clock()
	limit := cmp.Or(c.max, maxAdvisoryEntries)
	for k, e := range c.entries {
		if k != keep && !now.Before(e.expires) && !now.Before(e.pkgsUntil) {
			delete(c.entries, k)
		}
	}
	for k := range c.entries {
		if len(c.entries) <= limit {
			return
		}
		if k != keep {
			delete(c.entries, k)
		}
	}
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
		slog.Debug("lockfile too big to read", "forge", dashboard.ForgeForgejo, "repo", repo, "files", skipped)

		return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
	}
	if len(files) == 0 {
		return nil, dashboard.UnknownAdvisories(), nil
	}

	var pkgs []osv.Package
	for _, file := range files {
		data, err := c.rawFile(ctx, owner, name, file)
		if errors.Is(err, errResponseTooBig) {
			slog.Debug("lockfile too big to read", "forge", dashboard.ForgeForgejo, "repo", repo, "files", []string{file})

			return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
		}
		if err != nil {
			return nil, nil, err
		}
		got, err := lockfileReaders[file](data)
		if err != nil {
			slog.Debug("lockfile unreadable", "forge", dashboard.ForgeForgejo, "repo", repo, "file", file, "error", err)

			return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
		}
		pkgs = append(pkgs, got...)
	}
	pkgs, dropped := c.withoutOwnHost(pkgs)
	if dropped > 0 && len(pkgs) == 0 {
		slog.Debug("only modules on the forge's own host", "forge", dashboard.ForgeForgejo, "repo", repo)

		return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
	}
	if pkgs == nil {
		pkgs = []osv.Package{} // read, and empty: not "not read yet"
	}

	return pkgs, nil, nil
}

// withoutOwnHost drops the Go modules whose path starts with this forge's own
// host: they are the instance's private modules, and their names stay home. The
// host is compared as a lower-case name without its port on both sides, since
// DNS names ignore case and a module path may or may not carry the port. It
// says how many modules it dropped.
func (c *Client) withoutOwnHost(pkgs []osv.Package) (kept []osv.Package, dropped int) {
	u, err := url.Parse(c.instanceURL)
	if err != nil || u.Hostname() == "" {
		return pkgs, 0
	}
	own := strings.ToLower(u.Hostname())
	for _, p := range pkgs {
		if p.Ecosystem == osv.EcosystemGo && moduleHost(p.Name) == own {
			dropped++

			continue
		}
		kept = append(kept, p)
	}

	return kept, dropped
}

// moduleHost is the lower-case host name a Go module path starts with, without
// a port.
func moduleHost(module string) string {
	first, _, _ := strings.Cut(module, "/")
	if u, err := url.Parse("//" + first); err == nil && u.Hostname() != "" {
		first = u.Hostname()
	}

	return strings.ToLower(first)
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

// rawFile reads one file of the default branch, no more than maxLockfileBytes of
// it whatever the listing said it weighs.
func (c *Client) rawFile(ctx context.Context, owner, name, file string) ([]byte, error) {
	path := fmt.Sprintf("/repos/%s/%s/raw/%s", url.PathEscape(owner), url.PathEscape(name), url.PathEscape(file))
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	body, resp, err := c.rawRequestMax(ctx, http.MethodGet, path, nil, maxLockfileBytes)
	if errors.Is(err, errResponseTooBig) {
		return nil, err
	}
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}

	return body, nil
}

// advisoriesFor answers a repo's advisories from the cache when fresh, else
// reads them within advisoryDeadline. A failed read keeps the last answer for
// up to a day, so a short outage never turns a known count into unknown or
// zero and an old count never passes for current; it is asked again after a
// back-off that grows with each failure in a row, and the packages already read
// from the forge are kept for that retry. A lock file that can't be used is
// asked again after an hour, since the repo may fix it. With nothing cached a
// failure answers unknown. Without a scanner the answer is unknown, with the
// reason that advisories are not enabled.
func (c *Client) advisoriesFor(ctx context.Context, repo dashboard.RepoRef) *dashboard.Advisories {
	if c.advisoryScanner == nil {
		return &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonNotEnabled}
	}
	key := c.instanceURL + " " + repo.FullName
	for {
		old, fresh, _ := c.advisories.get(key)
		if fresh {
			return &old.value
		}
		call, leader := c.advisories.join(key)
		if leader {
			return c.lead(ctx, key, call, repo)
		}
		select {
		case <-call.done:
			if !call.cancelled || ctx.Err() != nil {
				return &call.value
			}
			// The leader gave up, not the forge: read for ourselves.
		case <-ctx.Done():
			return &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
		}
	}
}

// lead runs the read the caller won the right to run. Another caller may have
// finished the same repo between the cache check and the join, so it looks
// again before reading.
func (c *Client) lead(ctx context.Context, key string, call *advisoryCall, repo dashboard.RepoRef) *dashboard.Advisories {
	defer c.advisories.finish(key, call)
	old, fresh, have := c.advisories.get(key)
	if fresh {
		call.value = old.value

		return &call.value
	}
	v, cancelled := c.refreshAdvisories(ctx, key, repo, old, have)
	call.value, call.cancelled = *v, cancelled

	return &call.value
}

// cancelledAnswer is what a read that its caller cancelled answers with: the
// last answer, or unknown when there is none. Nothing is cached.
func (*Client) cancelledAnswer(old advisoryEntry, have bool) *dashboard.Advisories {
	if have {
		return &old.value
	}

	return &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
}

// refreshAdvisories reads a repo's advisories again and remembers the answer.
// It says when the read ended only because the caller's context did, in which
// case nothing is remembered.
func (c *Client) refreshAdvisories(ctx context.Context, key string, repo dashboard.RepoRef, old advisoryEntry, have bool) (*dashboard.Advisories, bool) {
	var known []osv.Package
	if old.havePkgs && c.advisories.clock().Before(old.pkgsUntil) {
		known = old.pkgs
	}
	deadline := cmp.Or(c.advisoryDeadline, advisoryDeadline)
	readCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	v, pkgs, err := c.readAdvisories(readCtx, repo.Owner, repo.Name, known)
	if err != nil && ctx.Err() != nil {
		// The caller gave up (shutdown, a superseded refresh): the forge and OSV
		// did nothing wrong, so remember nothing and let the next ask read again.
		return c.cancelledAnswer(old, have), true
	}
	if err != nil {
		return c.failedRead(key, repo, old, have, known, pkgs, err), false
	}
	now := c.advisories.clock()
	if v.State == dashboard.AdvisoriesUnknown && v.Reason == dashboard.ReasonFailed {
		// A lock file that can't be used: said once, then asked again later.
		if !old.unreadable {
			slog.Warn("lockfile can't be used, so the repo's advisories are unknown", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "retry", advisoriesUnreadableRetry)
		}
		c.advisories.put(key, advisoryEntry{value: v, unreadable: true}, advisoriesUnreadableRetry)

		return &v, false
	}
	ttl := advisoriesTTL
	if v.State == dashboard.AdvisoriesUnknown {
		ttl = advisoriesUnreadableRetry // too many advisories: the same lock file gives the same answer
	}
	c.advisories.put(key, advisoryEntry{value: v, answered: now}, ttl)

	return &v, false
}

// failedRead remembers a read that failed: the last answer is kept while it is
// young enough, and the next try waits longer after each failure in a row.
func (c *Client) failedRead(key string, repo dashboard.RepoRef, old advisoryEntry, have bool, known, pkgs []osv.Package, err error) *dashboard.Advisories {
	slog.Warn("dependency advisories read failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "error", err)
	e := advisoryEntry{value: old.value, answered: old.answered, unreadable: old.unreadable, failures: old.failures + 1}
	stale := old.value.State == dashboard.AdvisoriesKnown && c.advisories.clock().Sub(old.answered) > advisoriesStaleMax
	if !have || stale {
		e.value = dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
	}
	switch {
	case known != nil:
		e.pkgs, e.havePkgs, e.pkgsUntil = old.pkgs, true, old.pkgsUntil
	case pkgs != nil:
		e.pkgs, e.havePkgs, e.pkgsUntil = pkgs, true, c.advisories.clock().Add(advisoriesTTL)
	}
	c.advisories.put(key, e, min(advisoriesRetry<<min(e.failures-1, 6), advisoriesRetryMax))

	return &e.value
}
