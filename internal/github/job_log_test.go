package github_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListChecks_CarriesTheCheckRunIDAsJobID(t *testing.T) {
	t.Parallel()

	f := &failedCheckServer{log: "x\n", calls: map[string]int{}}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)

	assert.EqualValues(t, 76, checkNamed(t, checks, "lint").JobID)
	assert.EqualValues(t, 77, checkNamed(t, checks, "test").JobID)
}

func TestJobLog(t *testing.T) {
	t.Parallel()

	serve := func(t *testing.T, logStatus, blobStatus int, blob string) *github.Client {
		t.Helper()
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/alrayyes/a/actions/jobs/77/logs", func(w http.ResponseWriter, r *http.Request) {
			if logStatus != 0 {
				w.WriteHeader(logStatus)
				writeJSON(t, w, map[string]any{"message": "nope"})

				return
			}
			http.Redirect(w, r, "/blob/job-77.log", http.StatusFound)
		})
		mux.HandleFunc("/blob/job-77.log", func(w http.ResponseWriter, r *http.Request) {
			if blobStatus != 0 {
				w.WriteHeader(blobStatus)

				return
			}
			var n int
			if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=-%d", &n); err == nil && n < len(blob) {
				w.WriteHeader(http.StatusPartialContent)
				_, _ = io.WriteString(w, blob[len(blob)-n:])

				return
			}
			_, _ = io.WriteString(w, blob)
		})
		srv := httptest.NewServer(mux)
		t.Cleanup(srv.Close)

		return github.NewClient("test-token", "", srv.URL)
	}

	t.Run("returns the whole log with colour codes stripped", func(t *testing.T) {
		t.Parallel()
		c := serve(t, 0, 0, "2026-10-03T10:01:29Z \x1b[31mFAIL\x1b[0m <b>x</b>\nsecret ***\n")

		got, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

		require.NoError(t, err)
		assert.Equal(t, "2026-10-03T10:01:29Z FAIL <b>x</b>\nsecret ***\n", got.Text)
		assert.False(t, got.Truncated)
	})
	t.Run("keeps only the end of a huge log and says so", func(t *testing.T) {
		t.Parallel()
		c := serve(t, 0, 0, strings.Repeat("a line of output\n", 40000)+"last line\n")

		got, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

		require.NoError(t, err)
		assert.True(t, got.Truncated)
		assert.LessOrEqual(t, len(got.Text), dashboard.MaxJobLogBytes)
		assert.True(t, strings.HasSuffix(got.Text, "last line\n"))
		assert.True(t, strings.HasPrefix(got.Text, "a line of output\n"))
	})
	t.Run("a refusal is a classified client error", func(t *testing.T) {
		t.Parallel()
		for name, tc := range map[string]struct {
			logStatus, blobStatus int
			kind                  dashboard.ForgeErrorKind
		}{
			"token cannot read":  {logStatus: http.StatusForbidden, kind: dashboard.ForgeErrorUnauthorized},
			"no such job":        {logStatus: http.StatusNotFound, kind: dashboard.ForgeErrorNotFound},
			"log expired (blob)": {blobStatus: http.StatusNotFound, kind: dashboard.ForgeErrorNotFound},
			"log gone (blob)":    {blobStatus: http.StatusGone, kind: dashboard.ForgeErrorNotFound},
		} {
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				c := serve(t, tc.logStatus, tc.blobStatus, "")

				_, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

				var ce *dashboard.ClientError
				require.ErrorAs(t, err, &ce)
				assert.Equal(t, tc.kind, ce.Kind)
			})
		}
	})
}
