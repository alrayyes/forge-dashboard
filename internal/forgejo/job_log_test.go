package forgejo_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
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
