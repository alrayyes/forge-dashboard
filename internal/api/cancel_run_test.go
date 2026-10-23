package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// cancelSource records each run it is asked to cancel.
type cancelSource struct {
	fakeConfiguredSource
	err    error
	mu     sync.Mutex
	called []string
}

func (s *cancelSource) CancelRun(_ context.Context, owner, name string, runID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.called = append(s.called, fmt.Sprintf("%s/%s:%d", owner, name, runID))

	return s.err
}

func (s *cancelSource) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.called...)
}

func cancelBoard(t *testing.T, cancelErr error) (*httptest.Server, *http.Cookie, *cancelSource) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &cancelSource{err: cancelErr}
	src.health = dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}
	src.repos = []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"}}
	srv := newTestServerWithSources(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	return srv, cookie, src
}

func postCancelRun(t *testing.T, srvURL string, cookie *http.Cookie, body string) (int, map[string]any) {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/checks/cancel-run", strings.NewReader(body))
	require.NoError(t, err)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	var got map[string]any
	if len(raw) > 0 {
		require.NoError(t, json.Unmarshal(raw, &got), string(raw))
	}

	return resp.StatusCode, got
}

const cancelBody = `{"forge":"github","fullName":"alrayyes/a","runId":77}`

func TestCancelRun_CancelsTheRun_AndAnswers204(t *testing.T) {
	t.Parallel()

	srv, cookie, src := cancelBoard(t, nil)

	status, _ := postCancelRun(t, srv.URL, cookie, cancelBody)

	assert.Equal(t, http.StatusNoContent, status)
	assert.Equal(t, []string{"alrayyes/a:77"}, src.calls())
}

func TestCancelRun_ShowsTheForgesOwnReason_WhenItRefuses(t *testing.T) {
	t.Parallel()

	srv, cookie, _ := cancelBoard(t, &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("cannot cancel a workflow run that is completed")})

	status, body := postCancelRun(t, srv.URL, cookie, cancelBody)

	assert.Equal(t, http.StatusConflict, status)
	assert.Contains(t, fmt.Sprint(body["message"], body["error"]), "completed")
}

func TestCancelRun_RefusesABadBody_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"not json":       `nope`,
		"no run":         `{"forge":"github","fullName":"alrayyes/a"}`,
		"negative run":   `{"forge":"github","fullName":"alrayyes/a","runId":-1}`,
		"bad repository": `{"forge":"github","fullName":"alrayyes","runId":3}`,
		"unknown forge":  `{"forge":"nope","fullName":"alrayyes/a","runId":3}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv, cookie, src := cancelBoard(t, nil)

			status, _ := postCancelRun(t, srv.URL, cookie, body)

			assert.Equal(t, http.StatusBadRequest, status)
			assert.Empty(t, src.calls())
		})
	}
}

func TestCancelRun_Needs_ASignedInUser(t *testing.T) {
	t.Parallel()

	srv, _, src := cancelBoard(t, nil)

	status, _ := postCancelRun(t, srv.URL, nil, cancelBody)

	assert.Equal(t, http.StatusUnauthorized, status)
	assert.Empty(t, src.calls())
}

func TestCancelRun_Answers400_WhenTheForgeCannotCancel(t *testing.T) {
	t.Parallel()

	srv, cookie, _ := rerunBoardFor(t, dashboard.ForgeGitHub, nil)

	status, _ := postCancelRun(t, srv.URL, cookie, cancelBody)

	assert.Equal(t, http.StatusBadRequest, status)
}

func TestCancelRun_RefusesARepositoryTheDashboardDoesNotTrack_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	srv, cookie, src := cancelBoard(t, nil)

	status, body := postCancelRun(t, srv.URL, cookie, `{"forge":"github","fullName":"alrayyes/elsewhere","runId":77}`)

	assert.Equal(t, http.StatusNotFound, status)
	assert.Contains(t, fmt.Sprint(body["error"]), "isn't tracked")
	assert.Equal(t, "unknown", body["code"], "an ActionError, so a dialog shows its message")
	assert.Contains(t, fmt.Sprint(body["message"]), "isn't tracked")
	assert.Empty(t, src.calls())
}
