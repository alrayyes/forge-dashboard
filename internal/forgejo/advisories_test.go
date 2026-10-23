package forgejo_test

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/osv"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeScanner stands in for OSV: it records what it was asked and answers with
// a canned summary or error.
type fakeScanner struct {
	mu      sync.Mutex
	asked   [][]osv.Package
	summary osv.Summary
	err     error
}

func (f *fakeScanner) Scan(_ context.Context, pkgs []osv.Package) (osv.Summary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, pkgs)

	return f.summary, f.err
}

func (f *fakeScanner) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return len(f.asked)
}

// lockfileServer plays Forgejo for alrayyes/a: files maps a root file name to
// its content, and listCode, when set, fails the root listing.
type lockfileServer struct {
	files    map[string]string
	sizes    map[string]int // overrides the size the listing states for a file
	listCode int
	rawCode  int
	requests atomic.Int32
	url      string // set by start

	branch      string // a slashed branch name the fake resolves to a commit
	maxPerPage  int    // the server's own page size limit; zero means 1000
	filler      int    // extra files ahead of the rest in the tree, to make it span pages
	mu          sync.Mutex
	treeQueries []string // "ref?query" of each tree call
}

func (s *lockfileServer) start(t *testing.T, scanner forgejo.AdvisoryScanner) *forgejo.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/git/trees/{ref}", func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		s.mu.Lock()
		s.treeQueries = append(s.treeQueries, r.PathValue("ref")+"?"+r.URL.RawQuery)
		s.mu.Unlock()
		if s.listCode != 0 {
			w.WriteHeader(s.listCode)

			return
		}
		entries := []map[string]any{{"path": "README.md", "type": "blob", "size": 10}, {"path": "src", "type": "tree"}}
		names := make([]string, 0, len(s.files))
		for name := range s.files {
			names = append(names, name)
		}
		slices.Sort(names)
		for _, name := range names {
			size := len(s.files[name])
			if n, ok := s.sizes[name]; ok {
				size = n
			}
			entries = append(entries, map[string]any{"path": name, "type": "blob", "size": size})
		}
		// Filler goes first so a lock file lands on a later page, as in a big repo.
		filler := make([]map[string]any, 0, s.filler+len(entries))
		for i := range s.filler {
			filler = append(filler, map[string]any{"path": fmt.Sprintf("assets/f%05d.txt", i), "type": "blob", "size": 1})
		}
		entries = append(filler, entries...)
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
		page, perPage = max(page, 1), min(max(perPage, 1), cmp.Or(s.maxPerPage, 1000))
		lo := min((page-1)*perPage, len(entries))
		hi := min(lo+perPage, len(entries))
		// Like Forgejo, truncated is set whenever the whole tree is bigger than a page.
		writeJSON(t, w, map[string]any{"tree": entries[lo:hi], "page": page, "total_count": len(entries), "truncated": len(entries) > perPage})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branches/{name...}", func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		if r.PathValue("name") != s.branch {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		writeJSON(t, w, map[string]any{"name": s.branch, "commit": map[string]any{"id": "abc123"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/raw/{file...}", func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		if s.rawCode != 0 {
			w.WriteHeader(s.rawCode)

			return
		}
		_, _ = w.Write([]byte(s.files[r.PathValue("file")]))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	s.url = srv.URL
	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetAdvisoryScanner(scanner)

	return client
}

const lockJSON = `{"lockfileVersion":3,"packages":{"":{},"node_modules/left-pad":{"version":"1.3.0","resolved":"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"}}}`

func TestReadAdvisories_FillsCountAndSeverityFromTheLockfile(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 2, Highest: "high"}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON, "go.mod": "module x\n\nrequire github.com/a/b v1.2.3\n"}}).start(t, scanner)

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 2, Highest: dashboard.SeverityHigh}, got)
	require.Equal(t, 1, scanner.calls())
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"},
		{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"},
	}, scanner.asked[0])
}

func TestReadAdvisories_ACleanLockfileIsAKnownZero(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{})

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown}, got)
}

func TestReadAdvisories_NoLockfileIsUnknownNeverZero(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	client := (&lockfileServer{files: map[string]string{}}).start(t, scanner)

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Zero(t, scanner.calls(), "nothing to send to OSV")
}

func TestReadAdvisories_AnUnreadableLockfileIsUnknown(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": "not json"}}).start(t, &fakeScanner{})

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got)
}

func TestReadAdvisories_AnOSVOutageIsAnError(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{err: assert.AnError})

	_, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.Error(t, err)
}

func TestReadAdvisories_TooManyAdvisoriesIsUnknownWithItsReason(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{err: osv.ErrTooMany})

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonTooMany}, got)
}

func TestReadAdvisories_AForgeErrorIsAnError(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{listCode: http.StatusInternalServerError}).start(t, &fakeScanner{})

	_, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.Error(t, err)
}

func TestReadMainBranch_CarriesAdvisoriesAndReadsThemOncePerWindow(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1, Highest: "low"}}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	client := forge.start(t, scanner)

	for range 3 {
		row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
		require.NoError(t, err)
		require.NotNil(t, row.Advisories)
		assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 1, Highest: dashboard.SeverityLow}, *row.Advisories)
	}
	assert.Equal(t, 1, scanner.calls())
	assert.EqualValues(t, 2, forge.requests.Load(), "one listing and one file read, then the cache answers")
}

func TestReadMainBranch_AFailedReadKeepsTheLastAnswer(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 4, Highest: "high"}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, scanner)
	clk := withClock(client)

	first, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	require.Equal(t, 4, first.Advisories.Count)

	clk.advance(16 * time.Minute)
	scanner.mu.Lock()
	scanner.err = assert.AnError
	scanner.mu.Unlock()
	again, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Equal(t, 4, again.Advisories.Count, "an OSV outage never turns a known count into zero")
}

func TestReadMainBranch_WithoutAScannerTheRowSaysNotChecked(t *testing.T) {
	t.Parallel()
	row, err := (&mainBranchServer{}).start(t).ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.NotNil(t, row.Advisories)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonNotEnabled}, *row.Advisories)
}

// clock is a time the test moves by hand.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func withClock(client *forgejo.Client) *clock {
	c := &clock{t: time.Now()}
	forgejo.SetAdvisoryClock(client, c.now)

	return c
}

func TestReadAdvisories_ALockfileTooBigToReadMakesTheRepoUnknown(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{
		files: map[string]string{"package-lock.json": lockJSON, "go.mod": "module x\n\nrequire github.com/a/b v1.2.3\n"},
		sizes: map[string]int{"package-lock.json": 9 << 20},
	}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got, "the go.mod alone must not read as the whole repo")
	assert.Zero(t, scanner.calls())
}

func TestReadAdvisories_OneUnreadableLockfileMakesTheRepoUnknown(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1}}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": "not json", "go.mod": "module x\n\nrequire github.com/a/b v1.2.3\n"}}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Zero(t, scanner.calls())
}

func TestReadMainBranch_AnUnreadableLockfileIsAskedAgainAfterAnHour(t *testing.T) {
	t.Parallel()
	forge := &lockfileServer{files: map[string]string{"package-lock.json": "not json"}}
	client := forge.start(t, &fakeScanner{})
	clk := withClock(client)

	_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	clk.advance(50 * time.Minute)
	_, err = forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.EqualValues(t, 2, forge.requests.Load(), "a file that never parses is not read every five minutes")

	clk.advance(11 * time.Minute)
	_, err = forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.EqualValues(t, 4, forge.requests.Load(), "but the repo may fix it, so it is read again after an hour")
}

func TestReadMainBranch_AnOSVOutageDoesNotReadTheForgeAgain(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{err: assert.AnError}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	client := forge.start(t, scanner)
	clk := withClock(client)

	_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	require.EqualValues(t, 2, forge.requests.Load())

	scanner.mu.Lock()
	scanner.err = nil
	scanner.summary = osv.Summary{Count: 3, Highest: "high"}
	scanner.mu.Unlock()
	clk.advance(6 * time.Minute)
	row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Equal(t, 3, row.Advisories.Count)
	assert.Equal(t, 2, scanner.calls(), "OSV is asked again")
	assert.EqualValues(t, 2, forge.requests.Load(), "the lockfile is not read again")
}

func TestReadMainBranch_RetriesBackOff(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{err: assert.AnError}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, scanner)
	clk := withClock(client)
	read := func() {
		_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
		require.NoError(t, err)
	}

	read() // fails, ask again in 5 minutes
	clk.advance(5*time.Minute + time.Second)
	read() // fails, ask again in 10
	require.Equal(t, 2, scanner.calls())
	clk.advance(6 * time.Minute)
	read()
	assert.Equal(t, 2, scanner.calls(), "10 minutes haven't passed")
	clk.advance(5 * time.Minute)
	read()
	assert.Equal(t, 3, scanner.calls())
}

func TestReadMainBranch_ASlowReadGivesUpAtTheDeadline(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, blockingScanner{})
	forgejo.SetAdvisoryDeadline(client, 50*time.Millisecond)

	start := time.Now()
	row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Less(t, time.Since(start), 5*time.Second)
	require.NotNil(t, row.Advisories)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, *row.Advisories)
}

// blockingScanner never answers until its context ends.
type blockingScanner struct{}

func (blockingScanner) Scan(ctx context.Context, _ []osv.Package) (osv.Summary, error) {
	<-ctx.Done()

	return osv.Summary{}, fmt.Errorf("scan: %w", ctx.Err())
}

func TestReadMainBranch_AFailedFirstReadIsUnknown(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{listCode: http.StatusInternalServerError}).start(t, &fakeScanner{})

	row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	require.NotNil(t, row.Advisories)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, *row.Advisories)
}

func TestReadMainBranch_ManyFailuresInARowNeverMakeTheRetryImmediate(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{err: assert.AnError}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, scanner)
	clk := withClock(client)

	for i := range 60 {
		before := scanner.calls()
		for range 2 {
			_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
			require.NoError(t, err)
		}
		require.Equal(t, before+1, scanner.calls(), "read %d: a failed read is not asked again at once", i)
		clk.advance(31 * time.Minute)
	}
}

func TestReadMainBranch_ARootListing404IsAFailureNotAnEmptyRepo(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{listCode: http.StatusNotFound}).start(t, &fakeScanner{})

	_, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.Error(t, err)
}

func TestReadMainBranch_ConcurrentReadsOfOneRepoShareOneRead(t *testing.T) {
	t.Parallel()
	scanner := &slowScanner{}
	scanner.summary = osv.Summary{Count: 1}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	client := forge.start(t, scanner)

	var wg sync.WaitGroup
	for range 5 {
		wg.Go(func() {
			row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
			if err != nil {
				t.Error(err)

				return
			}
			assert.Equal(t, 1, row.Advisories.Count)
		})
	}
	wg.Wait()
	assert.Equal(t, 1, scanner.calls())
	assert.EqualValues(t, 2, forge.requests.Load())
}

// slowScanner answers after a pause, so parallel readers overlap.
type slowScanner struct{ fakeScanner }

func (s *slowScanner) Scan(ctx context.Context, pkgs []osv.Package) (osv.Summary, error) {
	time.Sleep(150 * time.Millisecond)

	return s.fakeScanner.Scan(ctx, pkgs)
}

func TestReadAdvisories_AFileBiggerThanItsListingSaidIsUnknown(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	big := strings.Repeat("x", 8<<20+1)
	client := (&lockfileServer{
		files: map[string]string{"package-lock.json": big},
		sizes: map[string]int{"package-lock.json": 10},
	}).start(t, scanner)

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got, "the cap holds whatever the listing claimed")
	assert.Zero(t, scanner.calls())
}

func TestReadMainBranch_ClientsShareAnAdvisoryCache(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 2, Highest: "low"}}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	cache := forgejo.NewAdvisoryCache()

	first := forge.start(t, scanner)
	first.ShareAdvisoryCache(cache)
	_, err := forgejo.ReadMainBranchSettled(t.Context(), first, repoA)
	require.NoError(t, err)

	// A login or a settings save builds a new client over the same forge.
	second := forgejo.NewClient(forge.url, "test-token", "")
	second.SetAdvisoryScanner(scanner)
	second.ShareAdvisoryCache(cache)
	row, err := forgejo.ReadMainBranchSettled(t.Context(), second, repoA)
	require.NoError(t, err)
	require.NotNil(t, row.Advisories)
	assert.Equal(t, 2, row.Advisories.Count)
	assert.Equal(t, 1, scanner.calls(), "the rebuilt client keeps what the old one learned")
}

func TestReadAdvisories_ModulesOnTheForgesOwnHostAreNotSent(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{}
	client := forge.start(t, scanner)
	host := strings.TrimPrefix(forge.url, "http://")
	forge.files = map[string]string{"go.mod": "module x\n\nrequire (\n\t" + host + "/team/secret v1.0.0\n\tgithub.com/a/b v1.2.3\n)\n"}

	_, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	require.Equal(t, 1, scanner.calls())
	assert.Equal(t, []osv.Package{{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"}}, scanner.asked[0])
}

func TestReadAdvisories_OnlyOwnHostModulesLeftIsUnknownNotZero(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{}
	client := forge.start(t, scanner)
	host := strings.TrimPrefix(forge.url, "http://")
	forge.files = map[string]string{"go.mod": "module x\n\nrequire " + host + "/team/secret v1.0.0\n"}

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got)
	assert.Zero(t, scanner.calls())
}

func TestReadMainBranch_AStaleCountIsNotKeptForever(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 4, Highest: "high"}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, scanner)
	clk := withClock(client)

	_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	scanner.mu.Lock()
	scanner.err = assert.AnError
	scanner.mu.Unlock()

	clk.advance(16 * time.Minute)
	row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Equal(t, 4, row.Advisories.Count, "a short outage keeps the last count")

	clk.advance(25 * time.Hour)
	row, err = forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, *row.Advisories,
		"a day-old count must not pass for current")
}

func TestReadAdvisories_AnOversizeReadIsRecordedInTheRequestLog(t *testing.T) {
	t.Parallel()
	forge := &lockfileServer{
		files: map[string]string{"package-lock.json": strings.Repeat("x", 8<<20+1)},
		sizes: map[string]int{"package-lock.json": 10},
	}
	forge.start(t, &fakeScanner{})
	rec := &fakeRecorder{}
	client := forgejo.NewClient(forge.url, "test-token", "", rec)
	client.SetAdvisoryScanner(&fakeScanner{})

	_, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	var raw int
	for _, e := range rec.all() {
		if strings.HasSuffix(e.Endpoint, "/raw/package-lock.json") {
			raw++
		}
	}
	assert.Equal(t, 1, raw, "the download happened, so it is counted")
}

func TestReadMainBranch_TooManyAdvisoriesIsNotReadAgainForAnHour(t *testing.T) {
	t.Parallel()
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	client := forge.start(t, &fakeScanner{err: osv.ErrTooMany})
	clk := withClock(client)

	_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	clk.advance(50 * time.Minute)
	_, err = forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.EqualValues(t, 2, forge.requests.Load(), "the same answer is not downloaded again every fifteen minutes")
}

func TestReadAdvisories_AQuotedOwnHostModuleIsNotSent(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{}
	client := forge.start(t, scanner)
	host := strings.TrimPrefix(forge.url, "http://")
	forge.files = map[string]string{"go.mod": "module x\n\nrequire \"" + host + "/team/lib\" v1.0.0\nrequire github.com/a/b v1.2.3\n"}

	_, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	require.Equal(t, 1, scanner.calls())
	assert.Equal(t, []osv.Package{{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"}}, scanner.asked[0])
}

func TestReadAdvisories_ReadsEachSupportedLockfileWithOneRawRead(t *testing.T) {
	t.Parallel()
	cases := []struct {
		file, content string
		want          osv.Package
	}{
		{"bun.lock", `{"packages":{"left-pad":["left-pad@1.3.0","",{},"sha512-a"],},}`, osv.Package{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"}},
		{"composer.lock", `{"packages":[{"name":"monolog/monolog","version":"3.5.0"}],"packages-dev":[]}`, osv.Package{Ecosystem: "Packagist", Name: "monolog/monolog", Version: "3.5.0"}},
		{"poetry.lock", "[[package]]\nname = \"requests\"\nversion = \"2.31.0\"\n", osv.Package{Ecosystem: "PyPI", Name: "requests", Version: "2.31.0"}},
		{"uv.lock", "[[package]]\nname = \"requests\"\nversion = \"2.31.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n", osv.Package{Ecosystem: "PyPI", Name: "requests", Version: "2.31.0"}},
		{"Cargo.lock", "[[package]]\nname = \"serde\"\nversion = \"1.0.190\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n", osv.Package{Ecosystem: "crates.io", Name: "serde", Version: "1.0.190"}},
		{"package-lock.json", `{"lockfileVersion":1,"dependencies":{"left-pad":{"version":"1.3.0","resolved":"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"}}}`, osv.Package{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"}},
	}
	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			t.Parallel()
			scanner := &fakeScanner{summary: osv.Summary{Count: 1, Highest: "high"}}
			forge := &lockfileServer{files: map[string]string{tc.file: tc.content}}
			client := forge.start(t, scanner)

			got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
			require.NoError(t, err)
			assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 1, Highest: dashboard.SeverityHigh}, got)
			require.Equal(t, 1, scanner.calls())
			assert.Equal(t, []osv.Package{tc.want}, scanner.asked[0])
			assert.EqualValues(t, 2, forge.requests.Load(), "one listing and one raw read")
		})
	}
}

func TestReadAdvisories_FindsLockfilesInSubdirectoriesWithOneTreeRead(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 3, Highest: "high"}}
	forge := &lockfileServer{files: map[string]string{
		"go.mod":                         "module x\n\nrequire github.com/a/b v1.2.3\n",
		"web/package-lock.json":          lockJSON,
		"services/api/package-lock.json": lockJSON,
	}}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 3, Highest: dashboard.SeverityHigh}, got)
	require.Equal(t, 1, scanner.calls(), "one scan for the whole repo")
	assert.ElementsMatch(t, []osv.Package{
		{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"},
		{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"},
	}, scanner.asked[0], "the same package in two lock files is sent once")
	assert.EqualValues(t, 4, forge.requests.Load(), "one tree read and three raw reads")
	require.Len(t, forge.treeQueries, 1)
	assert.Contains(t, forge.treeQueries[0], "recursive=true")
	assert.True(t, strings.HasPrefix(forge.treeQueries[0], "main?"))
}

func TestReadAdvisories_LeavesVendoredAndTestdataLockfilesAlone(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{files: map[string]string{
		"package-lock.json":                lockJSON,
		"node_modules/x/package-lock.json": "not json",
		"vendor/y/go.mod":                  "not a module",
		"internal/foo/testdata/go.mod":     "not a module",
	}}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.EqualValues(t, 2, forge.requests.Load(), "one tree read and the root lock file")
}

func TestReadAdvisories_TooManyLockfilesMakesTheRepoUnknown(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	files := map[string]string{}
	for i := range 25 {
		files[fmt.Sprintf("pkg%d/package-lock.json", i)] = lockJSON
	}
	forge := &lockfileServer{files: files}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got, "a cap that cut files off must not read as the whole repo")
	assert.Zero(t, scanner.calls())
	assert.EqualValues(t, 1, forge.requests.Load(), "no lock file is read past the cap")
}

func TestReadAdvisories_ALockfileOnASecondTreePageIsFound(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1}}
	forge := &lockfileServer{files: map[string]string{"web/package-lock.json": lockJSON}, filler: 1500}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 1}, got, "a big tree is paged, not given up on")
	require.Len(t, forge.treeQueries, 2)
	assert.Contains(t, forge.treeQueries[0], "page=1")
	assert.Contains(t, forge.treeQueries[1], "page=2")
	assert.EqualValues(t, 3, forge.requests.Load(), "two tree pages and one raw read")
}

func TestReadAdvisories_ATreeNeedingASixthPageIsUnknown(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}, filler: 5000}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got)
	assert.Zero(t, scanner.calls())
	assert.Len(t, forge.treeQueries, 5, "five pages are read, never a sixth")
}

func TestReadAdvisories_ATreeOfExactlyFivePagesIsRead(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	// README.md, src and the lock file make three entries.
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}, filler: 5000 - 3}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.Len(t, forge.treeQueries, 5)
}

func TestReadAdvisories_SkipRulesMatchWholeDirectoryNames(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{files: map[string]string{
		"vendored/package-lock.json":           lockJSON,
		"mynode_modules/go.mod":                "module x\n\nrequire github.com/a/b v1.2.3\n",
		"web/node_modules/x/package-lock.json": "not json",
	}}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State, "the nested node_modules file would not parse")
	assert.EqualValues(t, 3, forge.requests.Load(), "one tree read and the two look-alike directories")
}

func TestReadAdvisories_ASlashedBranchIsResolvedToItsCommit(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}, branch: "release/1"}

	got, err := forgejo.ReadAdvisoriesOn(t.Context(), forge.start(t, scanner), "alrayyes", "a", "release/1")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	require.Len(t, forge.treeQueries, 1)
	assert.True(t, strings.HasPrefix(forge.treeQueries[0], "abc123?"), "the tree is asked for by commit id: %s", forge.treeQueries[0])
}

func TestReadAdvisories_NoDefaultBranchIsUnknownWithoutACall(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}

	got, err := forgejo.ReadAdvisoriesOn(t.Context(), forge.start(t, scanner), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Empty(t, got.Reason, "an empty repo is not a failed read")
	assert.Zero(t, forge.requests.Load())
}

func TestReadAdvisories_AServerWithASmallerPageSizeIsStillReadInFull(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1}}
	// 900 entries in all: README.md, src and the lock file make three of them. The server
	// hands out 500 at a time whatever per_page says, so the second page holds the lock file.
	forge := &lockfileServer{files: map[string]string{"web/package-lock.json": lockJSON}, filler: 897, maxPerPage: 500}

	got, err := forgejo.ReadAdvisories(t.Context(), forge.start(t, scanner), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 1}, got)
	assert.Len(t, forge.treeQueries, 2)
}

const mixedLockJSON = `{"lockfileVersion":3,"packages":{"":{},
	"node_modules/left-pad":{"version":"1.3.0","resolved":"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"},
	"node_modules/@corp/secret":{"version":"2.0.0","resolved":"https://npm.corp.example/@corp/secret/-/secret-2.0.0.tgz"}}}`

func TestReadAdvisories_ALockfileWithPackagesLeftOutIsMarkedPartial(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1, Highest: "low"}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": mixedLockJSON}}).start(t, scanner)

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 1, Highest: dashboard.SeverityLow, Partial: true}, got)
	assert.Equal(t, []osv.Package{{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"}}, scanner.asked[0], "the private name stays home")
}

func TestReadAdvisories_APartialFileMakesTheWholeRepoPartial(t *testing.T) {
	t.Parallel()
	forge := &lockfileServer{files: map[string]string{
		"package-lock.json": lockJSON,
		"go.mod":            "module x\n\nrequire github.com/a/b v1.2.3\nrequire github.com/c/d v1.0.0\nreplace github.com/c/d => ../d\n",
	}}
	client := forge.start(t, &fakeScanner{})

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.True(t, got.Partial, "the clean npm file does not hide the go.mod that left a module out")
}

func TestReadAdvisories_AWholeLockfileIsNotPartial(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{})

	got, err := forgejo.ReadAdvisories(t.Context(), client, "alrayyes", "a")
	require.NoError(t, err)
	assert.False(t, got.Partial)
}

func TestReadMainBranch_ARetryAfterAnOSVOutageStillSaysPartial(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{err: assert.AnError}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": mixedLockJSON}}).start(t, scanner)
	clk := withClock(client)

	_, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	scanner.mu.Lock()
	scanner.err, scanner.summary = nil, osv.Summary{Count: 2}
	scanner.mu.Unlock()
	clk.advance(6 * time.Minute)
	row, err := forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown, Count: 2, Partial: true}, *row.Advisories)
}

// gatedScanner holds every scan until release is closed.
type gatedScanner struct {
	release chan struct{}
	started atomic.Int32
}

func (g *gatedScanner) Scan(ctx context.Context, _ []osv.Package) (osv.Summary, error) {
	g.started.Add(1)
	select {
	case <-g.release:
		return osv.Summary{Count: 1}, nil
	case <-ctx.Done():
		return osv.Summary{}, fmt.Errorf("scan: %w", ctx.Err())
	}
}

func TestReadMainBranch_AColdAdvisoryReadDoesNotHoldUpTheRow(t *testing.T) {
	t.Parallel()
	gate := &gatedScanner{release: make(chan struct{})}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, gate)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err, "the row comes back while OSV is still being asked")
	require.NotNil(t, row.Advisories)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown}, *row.Advisories, "unknown with no reason: not read yet, not failed")

	close(gate.release)
	row, err = forgejo.ReadMainBranchSettled(t.Context(), client, repoA)
	require.NoError(t, err)
	assert.Equal(t, 1, row.Advisories.Count, "the next refresh carries the answer")
}

func TestReadMainBranch_AColdStartAcrossManyReposStartsEveryReadAtOnce(t *testing.T) {
	t.Parallel()
	gate := &gatedScanner{release: make(chan struct{})}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, gate)
	const repos = 25

	for i := range repos {
		repo := repoA
		repo.FullName = fmt.Sprintf("alrayyes/a%d", i) // a cache key of its own, the same fake forge behind it
		row, err := client.ReadMainBranch(t.Context(), repo)
		require.NoError(t, err)
		assert.Equal(t, dashboard.AdvisoriesUnknown, row.Advisories.State)
	}
	assert.Eventually(t, func() bool { return gate.started.Load() == repos }, 5*time.Second, 5*time.Millisecond,
		"no repo waits for another's read before its own starts")
	close(gate.release)
	forgejo.WaitForAdvisories(client)
	for i := range repos {
		repo := repoA
		repo.FullName = fmt.Sprintf("alrayyes/a%d", i)
		row, err := client.ReadMainBranch(t.Context(), repo)
		require.NoError(t, err)
		assert.Equal(t, 1, row.Advisories.Count)
	}
}
