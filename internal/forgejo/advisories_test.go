package forgejo_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

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
			entries = append(entries, map[string]any{"name": name, "type": "file", "size": len(body)})
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

func TestReadMainBranch_WithoutAScannerThereAreNoAdvisories(t *testing.T) {
	t.Parallel()
	row, err := (&mainBranchServer{}).start(t).ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	assert.Nil(t, row.Advisories)
}

func TestReadMainBranch_AFailedFirstReadIsUnknown(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{listCode: http.StatusInternalServerError}).start(t, &fakeScanner{})

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.NotNil(t, row.Advisories)
	assert.Equal(t, dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonFailed}, *row.Advisories)
}
