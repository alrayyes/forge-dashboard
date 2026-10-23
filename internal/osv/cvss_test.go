package osv_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/osv"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// vectorOnly is an advisory that carries a CVSS vector and no database severity.
func vectorOnly(typ, vector string) map[string]any {
	return map[string]any{"severity": []map[string]any{{"type": typ, "score": vector}}}
}

func scanOne(t *testing.T, rec map[string]any) osv.Summary {
	t.Helper()
	s := &osvServer{
		vulns:  map[string][]string{"a@1.0.0": {"GHSA-1"}},
		detail: map[string]map[string]any{"GHSA-1": rec},
	}
	got, err := s.start(t).Scan(t.Context(), []osv.Package{{Ecosystem: "npm", Name: "a", Version: "1.0.0"}})
	require.NoError(t, err)

	return got
}

func TestScan_DerivesSeverityFromACVSSVector(t *testing.T) {
	t.Parallel()
	// Base scores are the published ones: FIRST's CVSS v3.x calculator and the
	// CVSS v4.0 reference implementation.
	for name, c := range map[string]struct {
		typ, vector, want string
	}{
		"v3.1 9.8":          {"CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "critical"},
		"v3.1 7.5":          {"CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", "high"},
		"v3.1 6.1":          {"CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", "medium"},
		"v3.0 3.3":          {"CVSS_V3", "CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N", "low"},
		"v4.0 9.3":          {"CVSS_V4", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", "critical"},
		"v4.0 7.9":          {"CVSS_V4", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:H/SI:H/SA:H", "high"},
		"v4.0 5.2":          {"CVSS_V4", "CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:N/VI:H/VA:H/SC:N/SI:L/SA:L", "medium"},
		"v4.0 1.0":          {"CVSS_V4", "CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", "low"},
		"prefix beats type": {"CVSS_V4", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "critical"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, osv.Summary{Count: 1, Highest: c.want}, scanOne(t, vectorOnly(c.typ, c.vector)))
		})
	}
}

func TestScan_TheDatabaseSeverityWinsOverTheVector(t *testing.T) {
	t.Parallel()
	rec := vectorOnly("CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")
	rec["database_specific"] = map[string]any{"severity": "LOW"}

	assert.Equal(t, osv.Summary{Count: 1, Highest: "low"}, scanOne(t, rec))
}

func TestScan_TheWorstVectorCounts(t *testing.T) {
	t.Parallel()
	rec := map[string]any{"severity": []map[string]any{
		{"type": "CVSS_V3", "score": "CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N"},
		{"type": "CVSS_V4", "score": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"},
	}}

	assert.Equal(t, osv.Summary{Count: 1, Highest: "critical"}, scanOne(t, rec))
}

func TestScan_AVectorTheScanCannotReadIsNoSeverity(t *testing.T) {
	t.Parallel()
	for name, vector := range map[string]string{
		"v2 vector":      "AV:N/AC:L/Au:N/C:P/I:P/A:P",
		"garbage":        "not a vector",
		"empty":          "",
		"truncated v3.1": "CVSS:3.1/AV:N/AC:L",
		"no impact":      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, osv.Summary{Count: 1}, scanOne(t, vectorOnly("CVSS_V3", vector)))
		})
	}
}
