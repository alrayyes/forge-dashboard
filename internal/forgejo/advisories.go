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
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/advisorycache"
	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/osv"
)

// The answer lifetime, the retry for a failed read and its back-off are shared
// with the GitHub source (see advisorycache). A failed read is asked again
// after advisorycache.Retry, then after twice that, and so on up to
// advisorycache.RetryMax, so an OSV outage isn't answered with a listing and a
// read per repo every five minutes.

// advisoriesUnreadableRetry is how long a repo whose lock file can't be used
// (too big, fails to parse, nothing in it to check) waits before it is read
// again. Such a file rarely changes, so five minutes would read it and log it
// twelve times an hour for nothing.
//
// advisoriesStaleMax is how long a failed read keeps showing the last count:
// past it the repo reads as unknown, so a number that old can't pass for
// current.
const (
	advisoriesUnreadableRetry = time.Hour
	advisoriesStaleMax        = 24 * time.Hour
)

// advisoryDeadline bounds one repo's advisory read. It runs inline with the
// repo's CI row, so a slow OSV must not hold that row up: a read that overruns
// is a failed read, answered from the last answer and asked again later. What
// OSV already returned is kept, so the next try gets further.
const advisoryDeadline = 10 * time.Second

// maxLockfiles is the most lock files one repo may have before it reads as
// unknown, and maxTreePages the most pages of the repo's file tree that are
// read to find them. Both keep a monorepo from costing an unbounded number of
// calls; a repo past either cap is unknown rather than counted from a part.
const (
	maxLockfiles  = 20
	maxTreePages  = 5
	treePageItems = 1000
)

// ignoredDirs hold copies of other projects' files, not this repo's own
// dependencies: their lock files are not read.
var ignoredDirs = map[string]bool{"node_modules": true, "vendor": true, "testdata": true}

// maxLockfileBytes is the largest lockfile read. A bigger one is left alone and
// the repo reads as unknown.
const maxLockfileBytes = 8 << 20

var errNoCommitID = errors.New("branch has no commit id")

var errNoAdvisoryScanner = errors.New("forgejo: no advisory scanner configured")

// AdvisoryScanner matches packages against a vulnerability database. osv.Client
// is the real one; a test stands in with its own.
type AdvisoryScanner interface {
	Scan(ctx context.Context, pkgs []osv.Package) (osv.Summary, error)
}

// lockfileReaders are the file names, wherever they sit in a repo, that list its pinned
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
func NewAdvisoryCache() *AdvisoryCache { return newAdvisoryCache() }

func newAdvisoryCache() *advisoryCache {
	c := &advisoryCache{}
	c.Hold = func(e advisoryEntry) time.Time { return e.pkgsUntil }

	return c
}

// AdvisoryCache remembers each repo's last answer and when to ask again. Its
// keys name the instance as well as the repo, so one cache can serve clients
// for different forges.
type AdvisoryCache = advisoryCache

type advisoryCache struct {
	advisorycache.Cache[advisoryEntry]
	callsMu sync.Mutex
	calls   map[string]*advisoryCall
}

type advisoryEntry struct {
	value dashboard.Advisories
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
	c.callsMu.Lock()
	defer c.callsMu.Unlock()
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
	c.callsMu.Lock()
	delete(c.calls, repo)
	c.callsMu.Unlock()
	close(call.done)
}

// readAdvisories reads a repo's advisories from the lockfiles anywhere in its
// default branch (any file in lockfileReaders: package-lock.json, bun.lock,
// composer.lock, poetry.lock, uv.lock, Cargo.lock and go.mod), matched against
// OSV, or
// starting from packages already read from the forge when known is set. Costs
// one read of the file tree (up to maxTreePages) plus one read per lockfile found. It returns the
// packages it read so a caller can keep them when OSV fails.
//
// A repo with no lockfile it can read is unknown, never zero. So is one where
// any lockfile is too big to read or fails to parse, since the others alone
// would read as the whole answer, and one that matches more advisories than a
// scan reads. A failed call to the forge or to OSV is an error. The package
// names and versions in the lockfiles are sent to OSV; nothing else is.
func (c *Client) readAdvisories(ctx context.Context, owner, name, branch string, known []osv.Package) (dashboard.Advisories, []osv.Package, error) {
	if c.advisoryScanner == nil {
		return dashboard.Advisories{}, nil, errNoAdvisoryScanner
	}
	ctx = apistats.WithKind(ctx, apistats.KindAdvisories)
	if branch == "" && known == nil {
		return *dashboard.UnknownAdvisories(), nil, nil // an empty repo has no branch to read
	}

	pkgs := known
	if pkgs == nil {
		got, answer, err := c.lockfilePackages(ctx, owner, name, branch)
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

// lockfilePackages reads the packages in the repo's lockfiles. When the answer
// is already settled without asking OSV (no lockfile, or one that can't be
// read in full) it returns that answer instead.
func (c *Client) lockfilePackages(ctx context.Context, owner, name, branch string) ([]osv.Package, *dashboard.Advisories, error) {
	repo := owner + "/" + name
	files, skipped, err := c.treeLockfiles(ctx, owner, name, branch)
	if err != nil {
		return nil, nil, err
	}
	if len(skipped) > 0 {
		slog.Debug("lockfiles left unread, so the repo is unknown", "forge", dashboard.ForgeForgejo, "repo", repo, "files", skipped)

		return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
	}
	if len(files) > maxLockfiles {
		slog.Debug("too many lockfiles to read", "forge", dashboard.ForgeForgejo, "repo", repo, "files", len(files))

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
		got, err := lockfileReaders[path.Base(file)](data)
		if err != nil {
			slog.Debug("lockfile unreadable", "forge", dashboard.ForgeForgejo, "repo", repo, "file", file, "error", err)

			return nil, &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, nil
		}
		pkgs = append(pkgs, got...)
	}
	pkgs = slices.Compact(slices.SortedFunc(slices.Values(pkgs), comparePackages))
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

// comparePackages orders packages by ecosystem, name and version, so the same
// package found in two lock files sits side by side and is sent once.
func comparePackages(a, b osv.Package) int {
	return cmp.Or(cmp.Compare(a.Ecosystem, b.Ecosystem), cmp.Compare(a.Name, b.Name), cmp.Compare(a.Version, b.Version))
}

// treeLockfiles lists the lock files anywhere in the default branch from its
// file tree, read recursively in at most maxTreePages calls. It returns the
// paths small enough to read and the names of what keeps the answer from being
// whole: lock files too big to read, or a tree the cap cut short, since files
// past the cap could change the answer.
func (c *Client) treeLockfiles(ctx context.Context, owner, name, branch string) (files, skipped []string, err error) {
	ref, err := c.treeRef(ctx, owner, name, branch)
	if err != nil {
		return nil, nil, err
	}
	base := fmt.Sprintf("/repos/%s/%s/git/trees/%s", url.PathEscape(owner), url.PathEscape(name), url.PathEscape(ref))
	seen := 0 // entries received so far; the server may page smaller than asked
	for page := 1; ; page++ {
		if page > maxTreePages {
			return nil, []string{"file tree past " + strconv.Itoa(maxTreePages) + " pages"}, nil
		}
		tree, err := c.treePage(ctx, fmt.Sprintf("%s?recursive=true&per_page=%d&page=%d", base, treePageItems, page))
		if err != nil {
			return nil, nil, err
		}
		f, sk := tree.lockfiles()
		files, skipped = append(files, f...), append(skipped, sk...)
		seen += len(tree.Tree)
		if seen >= tree.TotalCount || len(tree.Tree) == 0 {
			return files, skipped, nil
		}
	}
}

// treeRef is what to ask the tree route for. The route's {sha} segment can't
// hold a slash, so a branch like release/1 is resolved to its commit id first,
// at the cost of one more call. Other names go in as they are.
func (c *Client) treeRef(ctx context.Context, owner, name, branch string) (string, error) {
	if !strings.Contains(branch, "/") {
		return branch, nil
	}
	reqPath := fmt.Sprintf("/repos/%s/%s/branches/%s", url.PathEscape(owner), url.PathEscape(name), escapePath(branch))
	slog.Debug("forgejo request", "method", http.MethodGet, "url", reqPath)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, reqPath, nil)
	if err != nil {
		return "", c.forgejoError(ctx, http.MethodGet, reqPath, resp, err)
	}
	var b struct {
		Commit struct {
			ID string `json:"id"`
		} `json:"commit"`
	}
	if err := json.Unmarshal(body, &b); err != nil || b.Commit.ID == "" {
		return "", fmt.Errorf("forgejo: read %s: %w", reqPath, errNoCommitID)
	}

	return b.Commit.ID, nil
}

// gitTree is one page of Forgejo's recursive file tree.
type gitTree struct {
	Tree []struct {
		Path string `json:"path"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	} `json:"tree"`
	TotalCount int `json:"total_count"`
}

// lockfiles are the lock files on this page: the paths small enough to read,
// and those that are too big.
func (t gitTree) lockfiles() (files, skipped []string) {
	for _, e := range t.Tree {
		if _, ok := lockfileReaders[path.Base(e.Path)]; !ok || e.Type != "blob" || inIgnoredDir(e.Path) {
			continue
		}
		if e.Size > maxLockfileBytes {
			skipped = append(skipped, e.Path)
		} else {
			files = append(files, e.Path)
		}
	}

	return files, skipped
}

func (c *Client) treePage(ctx context.Context, reqPath string) (gitTree, error) {
	slog.Debug("forgejo request", "method", http.MethodGet, "url", reqPath)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, reqPath, nil)
	if err != nil {
		return gitTree{}, c.forgejoError(ctx, http.MethodGet, reqPath, resp, err)
	}
	var tree gitTree
	if err := json.Unmarshal(body, &tree); err != nil {
		return gitTree{}, fmt.Errorf("forgejo: read %s: %w", reqPath, err)
	}

	return tree, nil
}

// inIgnoredDir says whether any directory in p's path is one whose lock files
// are not read.
func inIgnoredDir(p string) bool {
	dir, _ := path.Split(p)
	for seg := range strings.SplitSeq(dir, "/") {
		if ignoredDirs[seg] {
			return true
		}
	}

	return false
}

// escapePath escapes each segment of a repo path and keeps the slashes.
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}

	return strings.Join(segs, "/")
}

// rawFile reads one file of the default branch, no more than maxLockfileBytes of
// it whatever the listing said it weighs.
func (c *Client) rawFile(ctx context.Context, owner, name, file string) ([]byte, error) {
	path := fmt.Sprintf("/repos/%s/%s/raw/%s", url.PathEscape(owner), url.PathEscape(name), escapePath(file))
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
		old, fresh, _ := c.advisories.Get(key)
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
	old, fresh, have := c.advisories.Get(key)
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
	if old.havePkgs && c.advisories.Clock().Before(old.pkgsUntil) {
		known = old.pkgs
	}
	deadline := cmp.Or(c.advisoryDeadline, advisoryDeadline)
	readCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	v, pkgs, err := c.readAdvisories(readCtx, repo.Owner, repo.Name, repo.DefaultBranch, known)
	if err != nil && ctx.Err() != nil {
		// The caller gave up (shutdown, a superseded refresh): the forge and OSV
		// did nothing wrong, so remember nothing and let the next ask read again.
		return c.cancelledAnswer(old, have), true
	}
	if err != nil {
		return c.failedRead(key, repo, old, have, known, pkgs, err), false
	}
	now := c.advisories.Clock()
	if v.State == dashboard.AdvisoriesUnknown && v.Reason == dashboard.ReasonFailed {
		// A lock file that can't be used: said once, then asked again later.
		if !old.unreadable {
			slog.Warn("lockfile can't be used, so the repo's advisories are unknown", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "retry", advisoriesUnreadableRetry)
		}
		c.advisories.Put(key, advisoryEntry{value: v, unreadable: true}, advisoriesUnreadableRetry)

		return &v, false
	}
	ttl := advisorycache.TTL
	if v.State == dashboard.AdvisoriesUnknown {
		ttl = advisoriesUnreadableRetry // too many advisories: the same lock file gives the same answer
	}
	c.advisories.Put(key, advisoryEntry{value: v, answered: now}, ttl)

	return &v, false
}

// failedRead remembers a read that failed: the last answer is kept while it is
// young enough, and the next try waits longer after each failure in a row.
func (c *Client) failedRead(key string, repo dashboard.RepoRef, old advisoryEntry, have bool, known, pkgs []osv.Package, err error) *dashboard.Advisories {
	slog.Warn("dependency advisories read failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "error", err)
	e := advisoryEntry{value: old.value, answered: old.answered, unreadable: old.unreadable, failures: old.failures + 1}
	stale := old.value.State == dashboard.AdvisoriesKnown && c.advisories.Clock().Sub(old.answered) > advisoriesStaleMax
	if !have || stale {
		e.value = dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}
	}
	switch {
	case known != nil:
		e.pkgs, e.havePkgs, e.pkgsUntil = old.pkgs, true, old.pkgsUntil
	case pkgs != nil:
		e.pkgs, e.havePkgs, e.pkgsUntil = pkgs, true, c.advisories.Clock().Add(advisorycache.TTL)
	}
	c.advisories.Put(key, e, advisorycache.Backoff(e.failures))

	return &e.value
}
