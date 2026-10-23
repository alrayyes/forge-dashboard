package osv

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSeverityFromScore_BandEdges(t *testing.T) {
	t.Parallel()
	for score, want := range map[float64]string{
		0: "", 0.1: "low", 3.9: "low", 4.0: "medium", 6.9: "medium",
		7.0: "high", 8.9: "high", 9.0: "critical", 10.0: "critical",
	} {
		assert.Equal(t, want, severityFromScore(score), "score %.1f", score)
	}
}

func TestSeverityFromVectors_TheWorstWinsWhereverItSits(t *testing.T) {
	t.Parallel()
	low := "CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N"
	crit := "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
	high := "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"
	assert.Equal(t, "critical", severityFromVectors([]string{crit, low}))
	assert.Equal(t, "critical", severityFromVectors([]string{low, crit, high}))
	assert.Equal(t, "critical", severityFromVectors([]string{low, crit}))
}
