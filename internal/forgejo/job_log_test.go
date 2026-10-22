package forgejo_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.JobLogReader = (*forgejo.Client)(nil)

func jobLogClient(t *testing.T, status int, body string) *forgejo.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/31/logs", func(w http.ResponseWriter, _ *http.Request) {
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = io.WriteString(w, body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestJobLog_ReturnsThePlainText(t *testing.T) {
	t.Parallel()

	client := jobLogClient(t, 0, "\x1b[32mok\x1b[0m <i>x</i>\r\ndone\n")

	got, err := client.JobLog(t.Context(), "alrayyes", "a", 31)

	require.NoError(t, err)
	assert.Equal(t, "ok <i>x</i>\ndone\n", got.Text)
	assert.False(t, got.Truncated)
}

func TestJobLog_Huge_KeepsTheEnd(t *testing.T) {
	t.Parallel()

	client := jobLogClient(t, 0, strings.Repeat("a line of output\n", 40000)+"last line\n")

	got, err := client.JobLog(t.Context(), "alrayyes", "a", 31)

	require.NoError(t, err)
	assert.True(t, got.Truncated)
	assert.LessOrEqual(t, len(got.Text), dashboard.MaxJobLogBytes)
	assert.True(t, strings.HasSuffix(got.Text, "last line\n"))
}

func TestJobLog_Refused_IsAClassifiedClientError(t *testing.T) {
	t.Parallel()

	for status, kind := range map[int]dashboard.ForgeErrorKind{
		http.StatusForbidden: dashboard.ForgeErrorUnauthorized,
		http.StatusNotFound:  dashboard.ForgeErrorNotFound,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			client := jobLogClient(t, status, `{"message":"nope"}`)

			_, err := client.JobLog(t.Context(), "alrayyes", "a", 31)

			var ce *dashboard.ClientError
			require.ErrorAs(t, err, &ce)
			assert.Equal(t, kind, ce.Kind)
		})
	}
}

func TestListDefaultBranchChecks_CarriesTheJobID(t *testing.T) {
	t.Parallel()

	client := branchChecksServer(t,
		[]map[string]any{actionRun(8, "main", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")},
		map[string][]map[string]any{"8": {{"id": 31, "name": "build", "status": "failure"}}})

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.EqualValues(t, 31, checks[0].JobID)
}

// Not parallel: it reads the process-wide allocation counter, and a serial
// test runs before the parallel ones resume.
func TestJobLog_HundredsOfMiB_CostsABoundedAmountOfMemory(t *testing.T) {
	const logBytes = 300 << 20
	line := []byte("a line of output that repeats until the log is huge............\n")
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/31/logs", func(w http.ResponseWriter, _ *http.Request) {
		for written := 0; written < logBytes; written += len(line) {
			_, _ = w.Write(line)
		}
		_, _ = io.WriteString(w, "last line\n")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "")

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	got, err := client.JobLog(t.Context(), "alrayyes", "a", 31)
	runtime.ReadMemStats(&after)

	require.NoError(t, err)
	assert.True(t, got.Truncated)
	assert.True(t, strings.HasSuffix(got.Text, "last line\n"))
	assert.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(logBytes/4), "allocation must not scale with the log")
}

func TestJobLog_Missing_IsAnErrorRowForTheLogEndpoint(t *testing.T) {
	t.Parallel()

	rec := &fakeRecorder{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/jobs/31/logs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := forgejo.NewClient(srv.URL, "test-token", "", rec)

	_, err := client.JobLog(t.Context(), "alrayyes", "a", 31)

	require.Error(t, err)
	entries := rec.all()
	require.Len(t, entries, 1)
	assert.NotEqual(t, requestlog.OutcomeSuccess, entries[0].Outcome, "a person asked for this log, so a missing one is a failed request")
}
