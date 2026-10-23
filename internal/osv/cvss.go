package osv

import (
	"strings"

	gocvss30 "github.com/pandatix/go-cvss/30"
	gocvss31 "github.com/pandatix/go-cvss/31"
	gocvss40 "github.com/pandatix/go-cvss/40"
)

// severityFromVectors maps the CVSS vectors of an OSV record's severity list
// to the dashboard's four levels and returns the worst. A vector this scan
// can't read (CVSS v2, a typo, a score of zero) is skipped, so the advisory
// still counts and just has no severity.
func severityFromVectors(vectors []string) string {
	worst := ""
	for _, v := range vectors {
		if sev := severityFromScore(baseScore(v)); severityRank[sev] > severityRank[worst] {
			worst = sev
		}
	}

	return worst
}

// baseScore reads the version from the vector's own prefix, not from the
// record's type tag, and returns 0 when the vector is not a v3.x or v4 one.
func baseScore(vector string) float64 {
	switch {
	case strings.HasPrefix(vector, "CVSS:3.1/"):
		if c, err := gocvss31.ParseVector(vector); err == nil {
			return c.BaseScore()
		}
	case strings.HasPrefix(vector, "CVSS:3.0/"):
		if c, err := gocvss30.ParseVector(vector); err == nil {
			return c.BaseScore()
		}
	case strings.HasPrefix(vector, "CVSS:4.0/"):
		if c, err := gocvss40.ParseVector(vector); err == nil {
			return c.Score()
		}
	}

	return 0
}

// severityFromScore applies the qualitative bands both CVSS v3.x and v4 define:
// 0.1 to 3.9 low, 4.0 to 6.9 medium, 7.0 to 8.9 high, 9.0 and up critical.
func severityFromScore(score float64) string {
	switch {
	case score >= 9.0:
		return "critical"
	case score >= 7.0:
		return "high"
	case score >= 4.0:
		return "medium"
	case score >= 0.1:
		return "low"
	default:
		return ""
	}
}
