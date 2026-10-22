package forgejo_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
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

var _ dashboard.AdvisoryReader = (*forgejo.Client)(nil)

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
}

func (s *lockfileServer) start(t *testing.T, scanner forgejo.AdvisoryScanner) *forgejo.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/contents", func(w http.ResponseWriter, _ *http.Request) {
		s.requests.Add(1)
		if s.listCode != 0 {
			w.WriteHeader(s.listCode)

			return
		}
		entries := []map[string]any{{"name": "README.md", "type": "file", "size": 10}, {"name": "src", "type": "dir"}}
		for name, body := range s.files {
			size := len(body)
			if n, ok := s.sizes[name]; ok {
				size = n
			}
			entries = append(entries, map[string]any{"name": name, "type": "file", "size": size})
		}
		writeJSON(t, w, entries)
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/raw/{file}", func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		if s.rawCode != 0 {
			w.WriteHeader(s.rawCode)

			return
		}
		_, _ = w.Write([]byte(s.files[r.PathValue("file")]))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetAdvisoryScanner(scanner)

	return client
}

const lockJSON = `{"lockfileVersion":3,"packages":{"":{},"node_modules/left-pad":{"version":"1.3.0"}}}`

func TestReadAdvisories_FillsCountAndSeverityFromTheLockfile(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 2, Highest: "high"}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON, "go.mod": "module x\n\nrequire github.com/a/b v1.2.3\n"}}).start(t, scanner)

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "https://forge.example/alrayyes/a")
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

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesKnown}, got)
}

func TestReadAdvisories_NoLockfileIsUnknownNeverZero(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{}
	client := (&lockfileServer{files: map[string]string{}}).start(t, scanner)

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Zero(t, scanner.calls(), "nothing to send to OSV")
}

func TestReadAdvisories_AnUnreadableLockfileIsUnknown(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": "not json"}}).start(t, &fakeScanner{})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got)
}

func TestReadAdvisories_AnOSVOutageIsAnError(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{err: assert.AnError})

	_, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.Error(t, err)
}

func TestReadAdvisories_TooManyAdvisoriesIsUnknownWithItsReason(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{err: osv.ErrTooMany})

	got, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonTooMany}, got)
}

func TestReadAdvisories_AForgeErrorIsAnError(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{listCode: http.StatusInternalServerError}).start(t, &fakeScanner{})

	_, err := client.ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.Error(t, err)
}

func TestReadMainBranch_CarriesAdvisoriesAndReadsThemOncePerWindow(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1, Highest: "low"}}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	client := forge.start(t, scanner)

	for range 3 {
		row, err := client.ReadMainBranch(t.Context(), repoA)
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
	forgejo.ExpireAdvisories(client)

	first, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.Equal(t, 4, first.Advisories.Count)

	forgejo.ExpireAdvisories(client)
	scanner.mu.Lock()
	scanner.err = assert.AnError
	scanner.mu.Unlock()
	again, err := client.ReadMainBranch(t.Context(), repoA)
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

	got, err := forge.start(t, scanner).ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, got, "the go.mod alone must not read as the whole repo")
	assert.Zero(t, scanner.calls())
}

func TestReadAdvisories_OneUnreadableLockfileMakesTheRepoUnknown(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{summary: osv.Summary{Count: 1}}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": "not json", "go.mod": "module x\n\nrequire github.com/a/b v1.2.3\n"}}

	got, err := forge.start(t, scanner).ReadAdvisories(t.Context(), "alrayyes", "a", "")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Zero(t, scanner.calls())
}

func TestReadMainBranch_AnUnreadableLockfileIsAskedAgainAfterTheShortRetry(t *testing.T) {
	t.Parallel()
	forge := &lockfileServer{files: map[string]string{"package-lock.json": "not json"}}
	client := forge.start(t, &fakeScanner{})
	clk := withClock(client)

	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	clk.advance(4 * time.Minute)
	_, err = client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	assert.EqualValues(t, 2, forge.requests.Load(), "still cached inside five minutes")

	clk.advance(2 * time.Minute)
	_, err = client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	assert.EqualValues(t, 4, forge.requests.Load(), "read again after five, not fifteen")
}

func TestReadMainBranch_AnOSVOutageDoesNotReadTheForgeAgain(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{err: assert.AnError}
	forge := &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}
	client := forge.start(t, scanner)
	clk := withClock(client)

	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.EqualValues(t, 2, forge.requests.Load())

	scanner.mu.Lock()
	scanner.err = nil
	scanner.summary = osv.Summary{Count: 3, Highest: "high"}
	scanner.mu.Unlock()
	clk.advance(6 * time.Minute)
	row, err := client.ReadMainBranch(t.Context(), repoA)
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
		_, err := client.ReadMainBranch(t.Context(), repoA)
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
	row, err := client.ReadMainBranch(t.Context(), repoA)
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

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.NotNil(t, row.Advisories)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, *row.Advisories)
}
