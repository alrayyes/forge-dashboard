package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeBodyEditorSource is fakeLabelerSource plus the body read and write both
// forge clients have.
type fakeBodyEditorSource struct {
	fakeLabelerSource
	body       string
	writeCalls int
	written    string
	labelCalls int
}

func newBodyEditorSource(forge dashboard.Forge, body string) *fakeBodyEditorSource {
	f := &fakeBodyEditorSource{body: body}
	f.forge = forge

	return f
}

func (f *fakeBodyEditorSource) AddLabel(ctx context.Context, owner, name string, number int, label string) error {
	f.labelCalls++

	return f.fakeLabelerSource.AddLabel(ctx, owner, name, number, label)
}

func (f *fakeBodyEditorSource) PullRequestBody(_ context.Context, _, _ string, _ int) (string, error) {
	return f.body, nil
}

func (f *fakeBodyEditorSource) SetPullRequestBody(_ context.Context, _, _ string, _ int, body string) error {
	f.writeCalls++
	f.written = body

	return nil
}

const (
	untickedBody = "intro\n\n- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n\noutro"
	tickedBody   = "intro\n\n- [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n\noutro"
)

func TestPullRequestRenovateRebase_TicksTheCheckboxOnEachForge(t *testing.T) {
	t.Parallel()

	for _, forge := range []dashboard.Forge{dashboard.ForgeGitHub, dashboard.ForgeForgejo} {
		t.Run(string(forge), func(t *testing.T) {
			t.Parallel()

			source := newBodyEditorSource(forge, untickedBody)
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, forge, source)

			resp := postRenovateRebase(t, srvURL, sessionCookie, string(forge), "alrayyes/tempus-fugit", 3)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNoContent, resp.StatusCode)
			assert.Equal(t, tickedBody, source.written)
			assert.Zero(t, source.labelCalls, "the label is only the fallback")
		})
	}
}

func TestPullRequestRenovateRebase_AlreadyTicked_IsAlreadyRequested(t *testing.T) {
	t.Parallel()

	source := newBodyEditorSource(dashboard.ForgeGitHub, tickedBody)
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postRenovateRebase(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 3)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var got map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "already_requested", got["code"])
	assert.Zero(t, source.writeCalls)
	assert.Zero(t, source.labelCalls)
}

func TestPullRequestRenovateRebase_NoCheckbox_FallsBackToTheLabel(t *testing.T) {
	t.Parallel()

	source := newBodyEditorSource(dashboard.ForgeForgejo, "no checkbox here")
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postRenovateRebase(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 3)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Zero(t, source.writeCalls)
	assert.Equal(t, "rebase", source.lastLabel)
}

func postRenovateRebaseCancel(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"forge": forge, "fullName": fullName, "number": number})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/v1/pull-requests/renovate-rebase/cancel", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func TestPullRequestRenovateRebaseCancel_UnticksTheCheckboxOnEachForge(t *testing.T) {
	t.Parallel()

	for _, forge := range []dashboard.Forge{dashboard.ForgeGitHub, dashboard.ForgeForgejo} {
		t.Run(string(forge), func(t *testing.T) {
			t.Parallel()

			source := newBodyEditorSource(forge, tickedBody)
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, forge, source)

			resp := postRenovateRebaseCancel(t, srvURL, sessionCookie, string(forge), "alrayyes/tempus-fugit", 3)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNoContent, resp.StatusCode)
			assert.Equal(t, untickedBody, source.written)
		})
	}
}

func TestPullRequestRenovateRebaseCancel_AnUntickedBoxIsLeftAlone(t *testing.T) {
	t.Parallel()

	source := newBodyEditorSource(dashboard.ForgeGitHub, untickedBody)
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postRenovateRebaseCancel(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 3)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Zero(t, source.writeCalls)
}
