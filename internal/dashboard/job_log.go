package dashboard

import (
	"context"
	"regexp"
	"strings"
)

// MaxJobLogBytes caps the log text one answer carries. A job log can run to
// many megabytes; a person reading it in a dialog wants the end, where a
// failure shows.
const MaxJobLogBytes = 256 * 1024

// JobLog is one Actions job's output as plain text. Truncated says the start
// was cut to fit MaxJobLogBytes.
type JobLog struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// JobLogReader is implemented by a Source (or a ForgeClient behind a
// GenericSource) that can read the output of one Actions job, by the id a
// Check carries. Fetched on demand, never as part of a snapshot.
type JobLogReader interface {
	JobLog(ctx context.Context, owner, name string, jobID int64) (JobLog, error)
}

var jobLogEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// NewJobLog turns the raw bytes a forge sent into a JobLog: colour codes and
// carriage returns removed, invalid UTF-8 dropped, and only the last
// MaxJobLogBytes kept, starting on a whole line. cut says raw is already only
// the end of a longer log, so its first line may be partial. Secrets are left
// as the forge masked them; nothing here edits the words.
func NewJobLog(raw []byte, cut bool) JobLog {
	text := strings.ToValidUTF8(string(raw), "")
	text = jobLogEscape.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	if len(text) <= MaxJobLogBytes && !cut {
		return JobLog{Text: text}
	}

	tail := text
	if len(tail) > MaxJobLogBytes {
		tail = tail[len(tail)-MaxJobLogBytes:]
		cut = true
	}
	if i := strings.IndexByte(tail, '\n'); cut && i >= 0 {
		tail = tail[i+1:]
	}

	return JobLog{Text: strings.ToValidUTF8(tail, ""), Truncated: true}
}
