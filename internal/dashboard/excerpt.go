package dashboard

import (
	"regexp"
	"strings"
	"time"
)

// The excerpt shown for a failed check in the pipeline dialog is capped in
// lines and bytes, the same on every forge.
const (
	ExcerptLines = 20
	ExcerptBytes = 2000
	// MaxExcerptJobs caps how many failed jobs of one list get an excerpt, each
	// costing at least one log request, so a run with dozens of failures can't
	// turn opening the dialog into a request storm.
	MaxExcerptJobs = 5
)

var (
	excerptEscape = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")
	excerptStamp  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?`)
)

// LogExcerpt turns the tail of a job log into the excerpt shown to a person:
// per-line timestamps and colour codes removed, blank lines dropped, the last
// few lines, capped in length. It stays plain text; nothing here interprets it
// as markup. partial says the text starts mid-line, so its first line is
// dropped.
func LogExcerpt(tail string, partial bool) string {
	tail = strings.ToValidUTF8(tail, "")
	lines := strings.Split(tail, "\n")
	if partial && len(lines) > 1 {
		lines = lines[1:]
	}
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		line = excerptEscape.ReplaceAllString(line, "")
		line = excerptStamp.ReplaceAllString(line, "")
		if line = strings.TrimRight(line, " \t\r"); line != "" {
			kept = append(kept, line)
		}
	}
	if len(kept) > ExcerptLines {
		kept = kept[len(kept)-ExcerptLines:]
	}
	for len(kept) > 1 && len(strings.Join(kept, "\n")) > ExcerptBytes {
		kept = kept[1:]
	}
	out := strings.Join(kept, "\n")
	if len(out) > ExcerptBytes {
		out = strings.ToValidUTF8(out[len(out)-ExcerptBytes:], "")
	}

	return out
}

// ExcerptReadTimeout bounds each failed job's log read for its excerpt, on both
// forges. The reads run together, so it also bounds the whole step.
const ExcerptReadTimeout = 15 * time.Second
