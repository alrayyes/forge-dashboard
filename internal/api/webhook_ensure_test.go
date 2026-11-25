package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeWebhookManagerSource implements both dashboard.Source and
// dashboard.WebhookManager directly — the shape github.Client has;
// GenericSource's own delegation to a ForgeClient is already covered by
// internal/dashboard's own tests, so this is enough to exercise the
// handler without a second copy of that coverage.
type fakeWebhookManagerSource struct {
	forge      dashboard.Forge
	ensureErr  error
	lastOwner  string
	lastName   string
	lastURL    string
	lastSecret string
}

func (f *fakeWebhookManagerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeWebhookManagerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeWebhookManagerSource) EnsureWebhook(_ context.Context, owner, name, targetURL, secret string) error {
	f.lastOwner, f.lastName, f.lastURL, f.lastSecret = owner, name, targetURL, secret

	return f.ensureErr
}

// fakeSourceWithoutWebhookSupport implements dashboard.Source only —
// the shape a forge with no webhook management at all would have.
type fakeSourceWithoutWebhookSupport struct{ forge dashboard.Forge }

func (f *fakeSourceWithoutWebhookSupport) Forge() dashboard.Forge { return f.forge }

func (f *fakeSourceWithoutWebhookSupport) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func postEnsureWebhook(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{"forge": forge, "fullName": fullName})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/v1/webhooks/ensure", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func TestWebhookEnsure_CallsEnsureWebhookWithTheAccountsOwnURLAndSecret(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, testPublicOrigin+"/api/webhooks/github/"+token, source.lastURL)
	assert.Equal(t, secret, source.lastSecret)
}

func TestWebhookEnsure_ForgejoDispatchesToTheForgejoSource(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeForgejo, source)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, testPublicOrigin+"/api/webhooks/forgejo/"+token, source.lastURL)
}

func TestWebhookEnsure_ClientErrorPropagatesAsASpecificMessage(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{
		forge: dashboard.ForgeGitHub,
		ensureErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	var body map[string]string
	require.NoError(t, readJSON(resp, &body))
	assert.Contains(t, body["error"], assert.AnError.Error())
}

// A refused ensure answers with the shared ActionError (#762), so the page
// locks from the code instead of classifying the message text itself.
func TestWebhookEnsure_Refusals_AnswerWithTheSharedActionError(t *testing.T) {
	t.Parallel()

	reset := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name        string
		err         error
		wantStatus  int
		wantCode    string
		wantMessage string
		wantResets  bool
	}{
		{
			name:        "permission",
			err:         &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("github: POST /repos/o/r/hooks: Resource not accessible")},
			wantStatus:  http.StatusForbidden,
			wantCode:    "permission",
			wantMessage: "Missing permission — check your token in Settings.",
		},
		{
			name:        "rate limited, with when it resets",
			err:         &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("github: POST x: rate limit exceeded"), RateLimit: &dashboard.RateLimit{ResetsAt: reset}},
			wantStatus:  http.StatusTooManyRequests,
			wantCode:    "rate_limited",
			wantMessage: "The forge's API rate limit is reached. Try again once it resets.",
			wantResets:  true,
		},
		{
			name:        "repo not found",
			err:         &dashboard.ClientError{Kind: dashboard.ForgeErrorNotFound, Err: errors.New("github: GET /repos/o/r/hooks: Not Found")},
			wantStatus:  http.StatusNotFound,
			wantCode:    "unknown",
			wantMessage: "The forge couldn't find this repo, or the token can't see it.",
		},
		{
			name:        "uncoded failure keeps internal text out of the message",
			err:         &dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: errors.New("forgejo: POST /repos/o/r/hooks: 500 {\"message\":\"boom\"}")},
			wantStatus:  http.StatusBadGateway,
			wantCode:    "unknown",
			wantMessage: "The forge refused this action and gave no reason.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub, ensureErr: tc.err}
			srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

			resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/a")
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, tc.wantStatus, resp.StatusCode)
			var body actionErrorBody
			require.NoError(t, readJSON(resp, &body))
			assert.Equal(t, tc.wantCode, body.Code)
			assert.Equal(t, tc.wantMessage, body.Message)
			if tc.wantResets {
				require.NotNil(t, body.ResetsAt)
				assert.True(t, reset.Equal(*body.ResetsAt))
			} else {
				assert.Nil(t, body.ResetsAt)
			}
		})
	}
}

// TestWebhookEnsure_EnsureWebhookFails_LogsTheError is a regression test
// for the same "can't diagnose from the outside" gap
// TestGitHubWebhook_InvalidSignature_LogsForgeEventAndDeliveryID
// (webhooks_test.go) closed for inbound deliveries: EnsureWebhook's own
// error only reached the HTTP response, so a failed webhook creation —
// like the real "Requires authentication" GitHub returned for a REST
// call missing its Authorization header — left nothing in the process's
// own logs to diagnose it from. Deliberately not t.Parallel(), for the
// same reason that test isn't: it swaps the global slog default.
func TestWebhookEnsure_EnsureWebhookFails_LogsTheError(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	source := &fakeWebhookManagerSource{
		forge:     dashboard.ForgeGitHub,
		ensureErr: errors.New("github: GET /repos/alrayyes/a/hooks: Requires authentication"),
	}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/a")
	defer func() { _ = resp.Body.Close() }()

	logged := logs.String()
	assert.Contains(t, logged, "webhook ensure failed")
	assert.Contains(t, logged, "forge=github")
	assert.Contains(t, logged, "repo=alrayyes/a")
	assert.Contains(t, logged, "Requires authentication")
}

func TestWebhookEnsure_ForgeWithNoWebhookSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutWebhookSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestWebhookEnsure_NoCredentialsSavedForThatForge_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestWebhookEnsure_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestWebhookEnsure_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerWithForgeSource(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]string{"forge": "github", "fullName": "alrayyes/a"})
	require.NoError(t, err)
	resp, err := testClient(t).Post(srvURL+"/api/v1/webhooks/ensure", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
