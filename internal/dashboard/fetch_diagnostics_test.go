package dashboard_test

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// logBuffer is a log sink safe to read while fetch goroutines write to it.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.buf.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.buf.String()
}

// captureDiagnosticLogs sends the default logger to a buffer at Debug. It sets a
// process-wide default, so the tests using it do not run in parallel.
func captureDiagnosticLogs(t *testing.T) *logBuffer {
	t.Helper()

	logs := &logBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	return logs
}

// failingSource answers every fetch with an error of a kind.
type failingSource struct {
	forge dashboard.Forge
	kind  dashboard.ForgeErrorKind
}

func (s failingSource) Forge() dashboard.Forge { return s.forge }

func (s failingSource) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: false, ErrorKind: s.kind, Error: "secret-looking text"}}
}

// A false "unreachable" banner has to be told from a real outage from the log
// alone (#4977): the deadline, the skipped fetch and each fetch's outcome all
// say how long the fetch ran.
func TestAggregator_LogsWhyAForgeWasMarkedUnreachable(t *testing.T) {
	logs := captureDiagnosticLogs(t)

	const userDeadline = time.Minute
	timers := newFakeTimers()
	fast := newHangingSource(dashboard.ForgeGitHub, 1)
	slow := newHangingSource(dashboard.ForgeForgejo, 10)
	t.Cleanup(slow.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{fast, slow},
		dashboard.WithClock(timers.Now),
		dashboard.WithUserFetchDeadline(userDeadline),
		dashboard.WithFetchDeadline(3*userDeadline, timers.After),
	)
	agg.Refresh(t.Context())
	<-fast.served
	<-slow.served

	assert.Contains(t, logs.String(), `level=DEBUG msg="fetch finished" forge=github duration=0s outcome=ok`,
		"a fetch that answered is a Debug line with its duration")

	slow.setHang(true)
	first, id := startRefresh(t, agg)
	<-slow.entered
	<-fast.served
	answersDelivered(t, id)
	timers.Advance(userDeadline)
	<-first

	assert.Contains(t, logs.String(), `level=WARN msg="fetch deadline passed with the forge still fetching" forge=forgejo running_for=1m0s deadline=1m0s`)

	timers.Advance(time.Minute)
	agg.Refresh(t.Context())

	assert.Contains(t, logs.String(), `level=WARN msg="fetch skipped, the last one is still running" forge=forgejo running_for=2m0s`)

	slow.unblock()
	require.Eventually(t, func() bool {
		return strings.Contains(logs.String(), `msg="fetch finished" forge=forgejo duration=2m0s outcome=late`)
	}, 5*time.Second, time.Millisecond, "a fetch that answers after the pass gave up says how late it was")
}

// A fetch that fails is a Warn line with its error kind and duration, and no
// text from the forge's reply.
func TestAggregator_LogsTheKindOfAFailedFetch(t *testing.T) {
	logs := captureDiagnosticLogs(t)

	agg := dashboard.NewAggregator([]dashboard.Source{failingSource{dashboard.ForgeGitHub, dashboard.ForgeErrorUpstream}})
	agg.Refresh(t.Context())

	assert.Contains(t, logs.String(), `level=WARN msg="fetch finished" forge=github duration=`)
	assert.Contains(t, logs.String(), "outcome=error error_kind=upstream_error")
	for line := range strings.SplitSeq(logs.String(), "\n") {
		if strings.Contains(line, `msg="fetch finished"`) {
			assert.NotContains(t, line, "secret-looking text")
		}
	}
}
