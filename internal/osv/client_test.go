package osv_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/osv"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// osvServer plays api.osv.dev: vulns maps "name@version" to the ids a
// querybatch answers, detail maps an id to its record.
type osvServer struct {
	vulns   map[string][]string
	detail  map[string]map[string]any
	batches atomic.Int32
	details atomic.Int32
	queries atomic.Int32
	fail    int
	delay   time.Duration
}

func (s *osvServer) start(t *testing.T) *osv.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/querybatch", func(w http.ResponseWriter, r *http.Request) {
		s.batches.Add(1)
		if s.fail != 0 {
			w.WriteHeader(s.fail)

			return
		}
		var req struct {
			Queries []struct {
				Version string `json:"version"`
				Package struct{ Name, Ecosystem string }
			} `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)

			return
		}
		s.queries.Add(int32(len(req.Queries))) //nolint:gosec // a test batch is far below int32
		results := make([]map[string]any, len(req.Queries))
		for i, q := range req.Queries {
			var vulns []map[string]string
			for _, id := range s.vulns[q.Package.Name+"@"+q.Version] {
				vulns = append(vulns, map[string]string{"id": id, "modified": "2026-01-01T00:00:00Z"})
			}
			results[i] = map[string]any{"vulns": vulns}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": results})
	})
	mux.HandleFunc("GET /v1/vulns/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.details.Add(1)
		time.Sleep(s.delay)
		d, ok := s.detail[r.PathValue("id")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		_ = json.NewEncoder(w).Encode(d)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return osv.NewClient(srv.URL, srv.Client())
}

func ghsa(severity string, aliases ...string) map[string]any {
	return map[string]any{"aliases": aliases, "database_specific": map[string]any{"severity": severity}}
}

func TestScan_CountsDistinctAdvisoriesAndTheWorstSeverity(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns: map[string][]string{
			"a@1.0.0": {"GHSA-1", "GHSA-2"},
			"b@2.0.0": {"GHSA-2", "GHSA-3"}, // GHSA-2 again, from another package
			"c@3.0.0": {"PYSEC-9"},          // the same flaw as GHSA-3, under an alias
		},
		detail: map[string]map[string]any{
			"GHSA-1":  ghsa("LOW"),
			"GHSA-2":  ghsa("MODERATE"),
			"GHSA-3":  ghsa("CRITICAL", "PYSEC-9"),
			"PYSEC-9": ghsa("", "GHSA-3"),
		},
	}
	client := s.start(t)

	got, err := client.Scan(t.Context(), []osv.Package{
		{Ecosystem: "npm", Name: "a", Version: "1.0.0"},
		{Ecosystem: "npm", Name: "b", Version: "2.0.0"},
		{Ecosystem: "npm", Name: "c", Version: "3.0.0"},
		{Ecosystem: "npm", Name: "clean", Version: "1.0.0"},
	})
	require.NoError(t, err)
	assert.Equal(t, osv.Summary{Count: 3, Highest: "critical"}, got)
}

func TestScan_NoMatchesIsAKnownZero(t *testing.T) {
	t.Parallel()
	client := (&osvServer{}).start(t)

	got, err := client.Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)
	assert.Equal(t, osv.Summary{}, got)
}

func TestScan_AnOutageIsAnErrorNeverAZero(t *testing.T) {
	t.Parallel()
	client := (&osvServer{fail: http.StatusServiceUnavailable}).start(t)

	_, err := client.Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.Error(t, err)
}

func TestScan_ASeverityItCannotReadStillCounts(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"X-1"}},
		detail: map[string]map[string]any{"X-1": {}},
	}

	got, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)
	assert.Equal(t, osv.Summary{Count: 1}, got)
}

func TestScan_SkipsWithdrawnAdvisories(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": {"withdrawn": "2026-01-01T00:00:00Z"}},
	}

	got, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)
	assert.Equal(t, osv.Summary{}, got)
}

func TestScan_ReadsAnAdvisoryOnce(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": ghsa("HIGH")},
	}
	client := s.start(t)
	pkgs := []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}}

	for range 3 {
		_, err := client.Scan(t.Context(), pkgs)
		require.NoError(t, err)
	}
	assert.EqualValues(t, 1, s.details.Load(), "an advisory's record is fetched once, then remembered")
}

func TestScan_SplitsABigLockfileIntoBatches(t *testing.T) {
	t.Parallel()
	s := &osvServer{}
	client := s.start(t)
	pkgs := make([]osv.Package, 1200)
	for i := range pkgs {
		pkgs[i] = osv.Package{Ecosystem: "npm", Name: fmt.Sprintf("p%d", i), Version: "1.0.0"}
	}

	_, err := client.Scan(t.Context(), pkgs)
	require.NoError(t, err)
	assert.EqualValues(t, 3, s.batches.Load())
}

func TestScan_TooManyAdvisoriesIsAnError(t *testing.T) {
	t.Parallel()
	s := &osvServer{vulns: map[string][]string{}, detail: map[string]map[string]any{}}
	var ids []string
	for i := range 400 {
		id := "GHSA-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		ids = append(ids, id)
		s.detail[id] = ghsa("LOW")
	}
	s.vulns["a@1.0.0"] = ids

	_, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.ErrorIs(t, err, osv.ErrTooMany)
}

func TestScan_CapCountsAdvisoriesAfterGrouping(t *testing.T) {
	t.Parallel()
	s := &osvServer{vulns: map[string][]string{}, detail: map[string]map[string]any{}}
	var ids []string
	for i := range 200 { // 200 advisories, each known under a GHSA and a GO id
		g, o := fmt.Sprintf("GHSA-%d", i), fmt.Sprintf("GO-%d", i)
		ids = append(ids, g, o)
		s.detail[g] = ghsa("LOW", o)
		s.detail[o] = ghsa("LOW", g)
	}
	s.vulns["a@1.0.0"] = ids

	got, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)
	assert.Equal(t, 200, got.Count)
}

func TestScan_RecordsSharingAnAliasNeitherListsAreOneAdvisory(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns: map[string][]string{"a@1.0.0": {"GHSA-1", "GO-1"}},
		detail: map[string]map[string]any{
			"GHSA-1": ghsa("HIGH", "CVE-2026-1"),
			"GO-1":   ghsa("", "CVE-2026-1"),
		},
	}

	got, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)
	assert.Equal(t, osv.Summary{Count: 1, Highest: "high"}, got)
}

func TestScan_AsksAboutEachNameAndVersionOnce(t *testing.T) {
	t.Parallel()
	s := &osvServer{}
	client := s.start(t)
	pkgs := []osv.Package{
		{Ecosystem: "npm", Name: "a", Version: "1.0.0"},
		{Ecosystem: "npm", Name: "a", Version: "1.0.0"},
	}

	_, err := client.Scan(t.Context(), pkgs)
	require.NoError(t, err)
	assert.EqualValues(t, 1, s.queries.Load())
}

func TestScan_TooManyPackagesIsAnError(t *testing.T) {
	t.Parallel()
	s := &osvServer{}
	pkgs := make([]osv.Package, osv.MaxPackages+1)
	for i := range pkgs {
		pkgs[i] = osv.Package{Ecosystem: "npm", Name: fmt.Sprintf("p%d", i), Version: "1.0.0"}
	}

	_, err := s.start(t).Scan(t.Context(), pkgs)
	require.ErrorIs(t, err, osv.ErrTooMany)
	assert.Zero(t, s.batches.Load(), "nothing is sent for a lockfile too big to read")
}

func TestScan_ConcurrentScansFetchARecordOnce(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": ghsa("HIGH")},
		delay:  50 * time.Millisecond,
	}
	client := s.start(t)

	var wg sync.WaitGroup
	for range 6 {
		wg.Go(func() {
			_, err := client.Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
			assert.NoError(t, err)
		})
	}
	wg.Wait()
	assert.EqualValues(t, 1, s.details.Load())
}

func TestScan_ARecordExpires(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": ghsa("LOW")},
	}
	client := s.start(t)
	now := time.Now()
	client.SetClock(func() time.Time { return now })
	pkgs := []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}}

	_, err := client.Scan(t.Context(), pkgs)
	require.NoError(t, err)
	now = now.Add(osv.RecordTTL + time.Second)
	_, err = client.Scan(t.Context(), pkgs)
	require.NoError(t, err)
	assert.EqualValues(t, 2, s.details.Load(), "a record is read again after its time to live")
}

func TestScan_AWaiterDoesNotInheritAnotherScansDeadline(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": ghsa("HIGH")},
		delay:  300 * time.Millisecond,
	}
	client := s.start(t)
	pkgs := []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}}

	short, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
	defer cancel()
	var wg sync.WaitGroup
	wg.Go(func() {
		_, err := client.Scan(short, pkgs)
		assert.Error(t, err)
	})
	time.Sleep(30 * time.Millisecond)

	got, err := client.Scan(t.Context(), pkgs)
	wg.Wait()
	require.NoError(t, err, "the first scan timing out must not fail a healthy one")
	assert.Equal(t, osv.Summary{Count: 1, Highest: "high"}, got)
}

func TestScan_StopsFetchingRecordsAfterTheFirstError(t *testing.T) {
	t.Parallel()
	s := &osvServer{vulns: map[string][]string{}, detail: map[string]map[string]any{}}
	var ids []string
	for i := range 500 {
		ids = append(ids, fmt.Sprintf("GHSA-%d", i)) // none has a record: every fetch is a 404
	}
	s.vulns["a@1.0.0"] = ids

	_, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.Error(t, err)
	assert.Less(t, s.details.Load(), int32(100), "a failing OSV doesn't cost a call per advisory")
}

func TestScan_TimeQueuedBehindTheFetchLimitIsNotCountedAgainstABudget(t *testing.T) {
	t.Parallel()
	const scans, perScan = 6, 8
	s := &osvServer{vulns: map[string][]string{}, detail: map[string]map[string]any{}, delay: 40 * time.Millisecond}
	var all [][]osv.Package
	for i := range scans {
		var pkgs []osv.Package
		for j := range perScan {
			name := fmt.Sprintf("p%d-%d", i, j)
			id := "GHSA-" + name
			s.vulns[name+"@1.0.0"] = []string{id}
			s.detail[id] = ghsa("LOW")
			pkgs = append(pkgs, osv.Package{Ecosystem: "npm", Name: name, Version: "1.0.0"})
		}
		all = append(all, pkgs)
	}
	client := s.start(t)

	// Six scans of eight records each share eight fetch slots, so the last one
	// waits about five fetches (200ms) before its own 40ms of work. A budget
	// that ran during the wait would cut it off.
	var wg sync.WaitGroup
	errs := make([]error, scans)
	for i := range scans {
		wg.Go(func() {
			ctx, cancel := osv.WithBudget(t.Context(), 150*time.Millisecond)
			defer cancel()
			_, errs[i] = client.Scan(ctx, all[i])
		})
	}
	wg.Wait()

	for i, err := range errs {
		require.NoError(t, err, "scan %d", i)
	}
}

func TestWithBudget_StillEndsAScanThatIsSlowItself(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": ghsa("LOW")},
		delay:  500 * time.Millisecond,
	}
	client := s.start(t)

	ctx, cancel := osv.WithBudget(t.Context(), 50*time.Millisecond)
	defer cancel()
	_, err := client.Scan(ctx, []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})

	require.Error(t, err)
	require.ErrorIs(t, ctx.Err(), context.Canceled)
	assert.ErrorIs(t, context.Cause(ctx), context.DeadlineExceeded)
}

func TestFind_GroupsAliasesAndKeepsWhatTheRecordStates(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns: map[string][]string{
			"a@1.0.0": {"GHSA-3"},
			"b@2.0.0": {"PYSEC-9", "GHSA-4"},
		},
		detail: map[string]map[string]any{
			"GHSA-3": {
				"aliases": []string{"CVE-2026-1", "PYSEC-9"}, "summary": "Prototype pollution",
				"details": "Long **text**", "published": "2026-02-03T04:05:06Z",
				"database_specific": map[string]any{"severity": "HIGH", "cwe_ids": []string{"CWE-1321"}},
				"severity": []map[string]any{
					{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"},
				},
				"references": []map[string]any{{"type": "WEB", "url": "https://example.com/a"}},
				"affected": []map[string]any{
					{
						"package": map[string]any{"name": "a", "ecosystem": "npm"},
						"ranges":  []map[string]any{{"events": []map[string]any{{"introduced": "0"}, {"fixed": "1.0.1"}}}},
					},
					{
						"package": map[string]any{"name": "other", "ecosystem": "npm"},
						"ranges":  []map[string]any{{"events": []map[string]any{{"fixed": "9.9.9"}}}},
					},
				},
			},
			"PYSEC-9": {"aliases": []string{"GHSA-3"}, "summary": "Same flaw, other id", "affected": []map[string]any{
				{
					"package": map[string]any{"name": "b", "ecosystem": "npm"},
					"ranges":  []map[string]any{{"events": []map[string]any{{"fixed": "2.1.0"}}}},
				},
			}},
			"GHSA-4": {"summary": "Second", "database_specific": map[string]any{"severity": "LOW"}},
		},
	}

	got, err := s.start(t).Find(t.Context(), []osv.Package{
		{Ecosystem: "npm", Name: "a", Version: "1.0.0"},
		{Ecosystem: "npm", Name: "b", Version: "2.0.0"},
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	byID := map[string]osv.Finding{}
	for _, f := range got {
		byID[f.ID] = f
	}

	first := byID["GHSA-3"]
	assert.Equal(t, []string{"CVE-2026-1", "GHSA-3", "PYSEC-9"}, first.IDs)
	assert.Equal(t, "Prototype pollution", first.Summary)
	assert.Equal(t, "Long **text**", first.Details)
	assert.Equal(t, "high", first.Severity)
	assert.Equal(t, "2026-02-03T04:05:06Z", first.Published)
	assert.Equal(t, []string{"CWE-1321"}, first.CWEs)
	assert.Equal(t, []string{"https://example.com/a"}, first.References)
	assert.Equal(t, "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", first.CVSSVector)
	assert.InDelta(t, 9.8, first.CVSSScore, 0.001)
	assert.Equal(t, []osv.Hit{
		{Package: osv.Package{Ecosystem: "npm", Name: "a", Version: "1.0.0"}, Fixed: []string{"1.0.1"}},
		{Package: osv.Package{Ecosystem: "npm", Name: "b", Version: "2.0.0"}, Fixed: []string{"2.1.0"}},
	}, first.Hits)

	second := byID["GHSA-4"]
	assert.Empty(t, second.CVSSVector, "a vector the record does not state stays empty")
	assert.Zero(t, second.CVSSScore)
	assert.Equal(t, []osv.Hit{{Package: osv.Package{Ecosystem: "npm", Name: "b", Version: "2.0.0"}}}, second.Hits)
}

func TestFind_NoMatchesIsAnEmptyList(t *testing.T) {
	t.Parallel()
	got, err := (&osvServer{}).start(t).Find(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestFind_FixVersionsComeFromTheSameEcosystem(t *testing.T) {
	t.Parallel()
	s := &osvServer{
		vulns: map[string][]string{"lib@1.0.0": {"GHSA-5"}},
		detail: map[string]map[string]any{
			"GHSA-5": {"summary": "Same name twice", "affected": []map[string]any{
				{
					"package": map[string]any{"name": "lib", "ecosystem": "npm"},
					"ranges":  []map[string]any{{"events": []map[string]any{{"fixed": "1.0.1"}}}},
				},
				{
					"package": map[string]any{"name": "lib", "ecosystem": "PyPI"},
					"ranges":  []map[string]any{{"events": []map[string]any{{"fixed": "7.7.7"}}}},
				},
			}},
		},
	}

	got, err := s.start(t).Find(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "lib", Version: "1.0.0"}})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, []string{"1.0.1"}, got[0].Hits[0].Fixed)
}
