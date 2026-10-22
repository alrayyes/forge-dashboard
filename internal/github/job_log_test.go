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

// jobLogServer redirects the logs request to blobURL (relative or absolute)
// and serves blob from /blob with the given status and headers.
func jobLogServer(t *testing.T, redirect string, blobHandler http.HandlerFunc) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/actions/jobs/77/logs", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirect, http.StatusFound)
	})
	mux.HandleFunc("/blob/job-77.log", blobHandler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestJobLog_PartialContentFromTheStartIsNotCut(t *testing.T) {
	t.Parallel()
	c := jobLogServer(t, "/blob/job-77.log", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Range", "bytes 0-17/18")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "first line\nlast\n")
	})

	got, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.NoError(t, err)
	assert.Equal(t, "first line\nlast\n", got.Text)
	assert.False(t, got.Truncated)
}

func TestJobLog_AnswerOverTheReadCapKeepsTheEnd(t *testing.T) {
	t.Parallel()
	c := jobLogServer(t, "/blob/job-77.log", func(w http.ResponseWriter, _ *http.Request) {
		line := strings.Repeat("x", 1023) + "\n"
		for range 17 * 1024 {
			_, _ = io.WriteString(w, line)
		}
		_, _ = io.WriteString(w, "the very last line\n")
	})

	got, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.NoError(t, err)
	assert.True(t, got.Truncated)
	assert.True(t, strings.HasSuffix(got.Text, "the very last line\n"))
}

func TestJobLog_ADownloadErrorDoesNotCarryTheSignedURL(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	var base string
	mux.HandleFunc("/repos/alrayyes/a/actions/jobs/77/logs", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, base+"/gone?sig=SECRETSIGNATURE", http.StatusFound)
	})
	mux.HandleFunc("/gone", func(w http.ResponseWriter, _ *http.Request) {
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		_ = conn.Close()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	base = srv.URL

	_, err := github.NewClient("test-token", "", srv.URL).JobLog(t.Context(), "alrayyes", "a", 77)

	require.Error(t, err)
	assert.NotContains(t, err.Error(), "SECRETSIGNATURE")
	assert.NotContains(t, err.Error(), "/gone")
}

func TestJobLog_RefusesARedirectToAnotherPlainHTTPHost(t *testing.T) {
	t.Parallel()
	var hits int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_, _ = io.WriteString(w, "should never be fetched")
	}))
	t.Cleanup(other.Close)
	c := jobLogServer(t, other.URL+"/blob/job-77.log", http.NotFound)

	_, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.Error(t, err)
	assert.Zero(t, hits)
}

func TestJobLog_AnExhaustedRateLimitIsRateLimited(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/actions/jobs/77/logs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		writeJSON(t, w, map[string]any{"message": "API rate limit exceeded"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	_, err := github.NewClient("test-token", "", srv.URL).JobLog(t.Context(), "alrayyes", "a", 77)

	var ce *dashboard.ClientError
	require.ErrorAs(t, err, &ce)
	assert.Equal(t, dashboard.ForgeErrorRateLimited, ce.Kind)
}

func TestJobLog_EveryRedirectHopIsChecked(t *testing.T) {
	t.Parallel()
	var hits int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_, _ = io.WriteString(w, "should never be fetched")
	}))
	t.Cleanup(other.Close)
	// The first hop is the API's own origin, which is allowed; the blob then
	// redirects on to another plain-http host.
	c := jobLogServer(t, "/blob/job-77.log", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/second", http.StatusFound)
	})

	_, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.Error(t, err)
	assert.Zero(t, hits)
}

func TestJobLog_ARedirectChainIsCapped(t *testing.T) {
	t.Parallel()
	var hops int
	c := jobLogServer(t, "/blob/job-77.log", func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, "/blob/job-77.log", http.StatusFound)
	})

	_, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.Error(t, err)
	assert.LessOrEqual(t, hops, 4)
}

func TestJobLog_AMovedLogsRequestNeverSendsTheTokenElsewhere(t *testing.T) {
	t.Parallel()
	var auth string
	var hits int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		auth = r.Header.Get("Authorization")
		http.Redirect(w, r, "/x", http.StatusFound)
	}))
	t.Cleanup(other.Close)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/repos/alrayyes/a/actions/jobs/77/logs", http.StatusMovedPermanently)
	}))
	t.Cleanup(api.Close)

	_, err := github.NewClient("test-token", "", api.URL).JobLog(t.Context(), "alrayyes", "a", 77)

	require.Error(t, err)
	assert.Zero(t, hits)
	assert.Empty(t, auth)
}

func TestJobLog_AnUnsatisfiableRangeIsAnEmptyLog(t *testing.T) {
	t.Parallel()
	c := jobLogServer(t, "/blob/job-77.log", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
	})

	got, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.NoError(t, err)
	assert.Empty(t, got.Text)
	assert.False(t, got.Truncated)
}

func TestJobLog_ABodyWithoutEndIsReadOnlyUpToACap(t *testing.T) {
	t.Parallel()
	c := jobLogServer(t, "/blob/job-77.log", func(w http.ResponseWriter, r *http.Request) {
		line := strings.Repeat("y", 1023) + "\n"
		for range 70 * 1024 {
			if _, err := io.WriteString(w, line); err != nil {
				return
			}
		}
	})

	got, err := c.JobLog(t.Context(), "alrayyes", "a", 77)

	require.NoError(t, err)
	assert.True(t, got.Truncated)
	assert.LessOrEqual(t, len(got.Text), dashboard.MaxJobLogBytes)
}
