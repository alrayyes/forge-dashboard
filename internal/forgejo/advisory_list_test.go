package forgejo_test

import (
	"context"
	"net/http"
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

const goMod = "module x\n\nrequire github.com/a/b v1.2.3\n"

var (
	leftPad = osv.Package{Ecosystem: "npm", Name: "left-pad", Version: "1.3.0"}
	modB    = osv.Package{Ecosystem: "Go", Name: "github.com/a/b", Version: "1.2.3"}
)

func TestListAdvisories_ListsEachAdvisoryWithItsPackageAndLockFile(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{findings: []osv.Finding{
		{
			ID: "GHSA-low", IDs: []string{"GHSA-low"}, Summary: "Minor", Severity: "low", Published: "2026-03-01T00:00:00Z",
			Hits: []osv.Hit{{Package: modB}},
		},
		{
			ID: "GHSA-bad", IDs: []string{"CVE-2026-1", "GHSA-bad"}, Summary: "Prototype pollution", Details: "Text",
			Severity: "high", Published: "2026-02-03T04:05:06Z", CVSSVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
			CVSSScore: 9.8, CWEs: []string{"CWE-1321"}, References: []string{"https://example.com/a"},
			Hits: []osv.Hit{{Package: leftPad, Fixed: []string{"1.3.1"}}},
		},
	}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON, "go.mod": goMod}}).start(t, scanner)

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)

	require.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.False(t, got.Partial)
	assert.Empty(t, got.URL, "OSV has no page for a whole repo")
	require.Len(t, got.Advisories, 2)
	assert.Equal(t, dashboard.AdvisoryItem{
		Number: 1, State: "open", Severity: dashboard.SeverityHigh, Summary: "Prototype pollution",
		ID: "GHSA-bad", GHSAID: "GHSA-bad", CVEID: "CVE-2026-1",
		Package: "left-pad@1.3.0", Ecosystem: "npm", ManifestPath: "package-lock.json",
		OpenedAt: "2026-02-03T04:05:06Z", PatchedVersion: "1.3.1",
		CVSS:        &dashboard.AdvisoryCVSS{Score: 9.8, Vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"},
		Weaknesses:  []dashboard.AdvisoryWeakness{{ID: "CWE-1321"}},
		Description: "Text", References: []string{"https://example.com/a"},
		URL: "https://osv.dev/vulnerability/GHSA-bad",
	}, got.Advisories[0])
	low := got.Advisories[1]
	assert.Equal(t, 2, low.Number)
	assert.Equal(t, "go.mod", low.ManifestPath)
	assert.Nil(t, low.CVSS, "a vector OSV does not state is left out")
	assert.Nil(t, low.EPSS)
	assert.Empty(t, low.Relationship)
	assert.Empty(t, low.Scope)
}

func TestListAdvisories_NamesEveryLockFileAPackageCameFrom(t *testing.T) {
	t.Parallel()
	scanner := &fakeScanner{findings: []osv.Finding{{
		ID: "GHSA-1", Summary: "S", Hits: []osv.Hit{{Package: leftPad}},
	}}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON, "sub/package-lock.json": lockJSON}}).start(t, scanner)

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	require.Len(t, got.Advisories, 1)
	assert.Equal(t, "package-lock.json, sub/package-lock.json", got.Advisories[0].ManifestPath)
}

func TestListAdvisories_ACleanRepoIsKnownAndEmpty(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, &fakeScanner{})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesKnown, got.State)
	assert.NotNil(t, got.Advisories)
	assert.Empty(t, got.Advisories)
}

func TestListAdvisories_SaysSoWhenPackagesWereLeftOut(t *testing.T) {
	t.Parallel()
	lock := `{"lockfileVersion":3,"packages":{"":{},"node_modules/a":{"version":"1.0.0","resolved":"https://registry.npmjs.org/a/-/a-1.0.0.tgz"},` +
		`"node_modules/priv":{"version":"1.0.0","resolved":"https://npm.example.com/priv.tgz"}}}`
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lock}}).start(t, &fakeScanner{})

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	assert.True(t, got.Partial)
}

func TestListAdvisories_UnknownWithItsForgejoCause(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		server *lockfileServer
		scan   *fakeScanner
		want   dashboard.AdvisoryReason
	}{
		{"OSV unreachable", &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}, &fakeScanner{err: assert.AnError}, dashboard.ReasonFailed},
		{"too many", &lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}, &fakeScanner{err: osv.ErrTooMany}, dashboard.ReasonTooMany},
		{"lock file does not parse", &lockfileServer{files: map[string]string{"package-lock.json": "not json"}}, &fakeScanner{}, dashboard.ReasonFailed},
		{"forge failed", &lockfileServer{listCode: http.StatusInternalServerError}, &fakeScanner{}, dashboard.ReasonFailed},
		{"no lock file", &lockfileServer{}, &fakeScanner{}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := tt.server.start(t, tt.scan).ListAdvisories(t.Context(), "alrayyes", "a")
			require.NoError(t, err)
			assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
			assert.Equal(t, tt.want, got.Reason)
			assert.NotNil(t, got.Advisories)
			assert.Empty(t, got.Advisories)
		})
	}
}

func TestListAdvisories_WithoutAScannerItIsNotEnabled(t *testing.T) {
	t.Parallel()
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, nil)

	got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	assert.Equal(t, dashboard.AdvisoriesUnknown, got.State)
	assert.Equal(t, dashboard.ReasonNotEnabled, got.Reason)
}

var _ dashboard.AdvisoryLister = (*forgejo.Client)(nil)

// gatedFinder holds every Find until release is closed and counts the calls.
type gatedFinder struct {
	fakeScanner
	release chan struct{}
	started chan struct{}
	finds   atomic.Int32
}

func (g *gatedFinder) Find(ctx context.Context, pkgs []osv.Package) ([]osv.Finding, error) {
	if g.finds.Add(1) == 1 {
		close(g.started)
	}
	<-g.release

	return g.fakeScanner.Find(ctx, pkgs)
}

func TestListAdvisories_ConcurrentOpensOfOneRepoShareOneRead(t *testing.T) {
	t.Parallel()
	scanner := &gatedFinder{release: make(chan struct{}), started: make(chan struct{})}
	scanner.findings = []osv.Finding{{ID: "GHSA-1", Summary: "S", Hits: []osv.Hit{{Package: leftPad}}}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, scanner)

	const opens = 3
	results := make([]dashboard.AdvisoryList, opens)
	var wg sync.WaitGroup
	for i := range opens {
		wg.Go(func() {
			got, err := client.ListAdvisories(t.Context(), "alrayyes", "a")
			assert.NoError(t, err)
			results[i] = got
		})
	}
	<-scanner.started
	require.Eventually(t, func() bool { return forgejo.ListJoined(client) == opens-1 }, 10*time.Second, time.Millisecond)
	close(scanner.release)
	wg.Wait()

	assert.EqualValues(t, 1, scanner.finds.Load(), "a double click costs one read")
	for _, got := range results {
		require.Len(t, got.Advisories, 1)
		assert.Equal(t, "GHSA-1", got.Advisories[0].ID)
	}
}

// panickingFinder panics on its first Find and answers normally afterwards.
type panickingFinder struct {
	fakeScanner
	finds atomic.Int32
}

func (p *panickingFinder) Find(ctx context.Context, pkgs []osv.Package) ([]osv.Finding, error) {
	if p.finds.Add(1) == 1 {
		panic("boom")
	}

	return p.fakeScanner.Find(ctx, pkgs)
}

func TestListAdvisories_APanickedReadDoesNotWedgeLaterOpens(t *testing.T) {
	t.Parallel()
	scanner := &panickingFinder{}
	scanner.findings = []osv.Finding{{ID: "GHSA-1", Summary: "S", Hits: []osv.Hit{{Package: leftPad}}}}
	client := (&lockfileServer{files: map[string]string{"package-lock.json": lockJSON}}).start(t, scanner)

	assert.Panics(t, func() { _, _ = client.ListAdvisories(t.Context(), "alrayyes", "a") })

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	got, err := client.ListAdvisories(ctx, "alrayyes", "a")
	require.NoError(t, err)
	require.Len(t, got.Advisories, 1)
}
