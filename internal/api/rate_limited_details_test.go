package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A details read the forge rate-limited says when the budget comes back, where
// that time is known (#5085).
func TestDetails_RateLimited_SaysWhenItResets(t *testing.T) {
	t.Parallel()

	reset := time.Date(2026, 3, 4, 15, 30, 0, 0, time.UTC)
	reads := map[string]func(t *testing.T, err error) *http.Response{
		"pull request": func(t *testing.T, err error) *http.Response {
			t.Helper()
			source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, detailsErr: err}
			srvURL, cookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

			return getPullRequestDetails(t, srvURL, cookie, "github", "alrayyes/a", 1)
		},
		"issue": func(t *testing.T, err error) *http.Response {
			t.Helper()
			source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, detailsErr: err}
			srvURL, cookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

			return getIssueDetails(t, srvURL, cookie, "github", "alrayyes/a", 1)
		},
		"release": func(t *testing.T, err error) *http.Response {
			t.Helper()
			source := &fakeReleaseDetailerSource{forge: dashboard.ForgeGitHub, detailsErr: err}
			srvURL, cookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

			return getReleaseDetails(t, srvURL, cookie, "github", "alrayyes/a", "v1.0.0")
		},
	}

	for name, tc := range map[string]struct {
		kind      dashboard.ForgeErrorKind
		rateLimit *dashboard.RateLimit
		want      any
	}{
		"exhausted budget": {
			dashboard.ForgeErrorRateLimited,
			&dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: reset},
			"2026-03-04T15:30:00Z",
		},
		"no figures": {dashboard.ForgeErrorRateLimited, nil, nil},
		"no reset time": {
			dashboard.ForgeErrorRateLimited,
			&dashboard.RateLimit{Limit: 5000},
			nil,
		},
		// A secondary limit: the primary budget's reset says nothing about it.
		"budget left": {
			dashboard.ForgeErrorRateLimited,
			&dashboard.RateLimit{Limit: 5000, Remaining: 4000, ResetsAt: reset},
			nil,
		},
		"another failure": {
			dashboard.ForgeErrorUnreachable,
			&dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: reset},
			nil,
		},
	} {
		for read, get := range reads {
			t.Run(read+", "+name, func(t *testing.T) {
				t.Parallel()

				resp := get(t, &dashboard.ClientError{Kind: tc.kind, Err: assert.AnError, RateLimit: tc.rateLimit})
				defer func() { _ = resp.Body.Close() }()

				var body map[string]any
				require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
				assert.Equal(t, assert.AnError.Error(), body["error"])
				assert.Equal(t, tc.want, body["resetsAt"])
			})
		}
	}
}
