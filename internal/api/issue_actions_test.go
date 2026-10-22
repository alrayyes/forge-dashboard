package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeIssueActionsSource implements dashboard.Source and the three issue
// capabilities: the shape github.Client and the Forgejo source have.
type fakeIssueActionsSource struct {
	forge   dashboard.Forge
	err     error
	calls   []string
	comment string
}

func (f *fakeIssueActionsSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeIssueActionsSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeIssueActionsSource) CloseIssue(_ context.Context, owner, name string, number int) error {
	f.calls = append(f.calls, "close "+owner+"/"+name+"#"+itoa(number))

	return f.err
}

func (f *fakeIssueActionsSource) ReopenIssue(_ context.Context, owner, name string, number int) error {
	f.calls = append(f.calls, "reopen "+owner+"/"+name+"#"+itoa(number))

	return f.err
}

func (f *fakeIssueActionsSource) CommentIssue(_ context.Context, owner, name string, number int, body string) error {
	f.calls = append(f.calls, "comment "+owner+"/"+name+"#"+itoa(number))
	f.comment = body

	return f.err
}

func itoa(n int) string {
	b, _ := json.Marshal(n)

	return string(b)
}

func postIssueAction(t *testing.T, srvURL string, sessionCookie *http.Cookie, action string, payload map[string]any) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/issues/"+action, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func issuePayload(extra map[string]any) map[string]any {
	p := map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": 12}
	for k, v := range extra {
		p[k] = v
	}

	return p
}

func TestIssueActions_CallTheForgeWithOwnerNameAndNumber(t *testing.T) {
	t.Parallel()

	for action, want := range map[string]string{
		"close":  "close alrayyes/tempus-fugit#12",
		"reopen": "reopen alrayyes/tempus-fugit#12",
	} {
		t.Run(action, func(t *testing.T) {
			t.Parallel()

			source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := postIssueAction(t, srvURL, cookie, action, issuePayload(nil))
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNoContent, resp.StatusCode)
			assert.Equal(t, []string{want}, source.calls)
		})
	}
}

func TestIssueComment_PostsTheCommentOnTheForgejoIssue(t *testing.T) {
	t.Parallel()

	source := &fakeIssueActionsSource{forge: dashboard.ForgeForgejo}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postIssueAction(t, srvURL, cookie, "comment", issuePayload(map[string]any{"forge": "forgejo", "body": "Fixed upstream."}))
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, []string{"comment alrayyes/tempus-fugit#12"}, source.calls)
	assert.Equal(t, "Fixed upstream.", source.comment)
}

func TestIssueComment_BlankOrTooLongBody_Returns400WithoutCallingTheForge(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"empty":      "",
		"whitespace": "  \n\t ",
		"too long":   strings.Repeat("a", 65537),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := postIssueAction(t, srvURL, cookie, "comment", issuePayload(map[string]any{"body": body}))
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			var got map[string]any
			require.NoError(t, readJSON(resp, &got))
			assert.Equal(t, "body", got["field"])
			assert.Empty(t, source.calls)
		})
	}
}

func TestIssueActions_PermissionRefusal_AnswersTheMissingPermission(t *testing.T) {
	t.Parallel()

	for _, action := range []string{"close", "reopen", "comment"} {
		t.Run(action, func(t *testing.T) {
			t.Parallel()

			source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub, err: &dashboard.ClientError{
				Kind:              dashboard.ForgeErrorUnauthorized,
				Err:               assert.AnError,
				PermissionMessage: "Changing an issue needs write access to issues.",
			}}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := postIssueAction(t, srvURL, cookie, action, issuePayload(map[string]any{"body": "hi"}))
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusForbidden, resp.StatusCode)
			var got map[string]any
			require.NoError(t, readJSON(resp, &got))
			assert.Equal(t, "permission", got["code"])
			assert.Equal(t, "Changing an issue needs write access to issues.", got["message"])
		})
	}
}

func TestIssueActions_RateLimited_AnswersWhenItResets(t *testing.T) {
	t.Parallel()

	resets := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub, err: &dashboard.ClientError{
		Kind:      dashboard.ForgeErrorRateLimited,
		Err:       assert.AnError,
		RateLimit: &dashboard.RateLimit{ResetsAt: resets},
	}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postIssueAction(t, srvURL, cookie, "close", issuePayload(nil))
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	var got map[string]any
	require.NoError(t, readJSON(resp, &got))
	assert.Equal(t, "rate_limited", got["code"])
	assert.Equal(t, resets.Format(time.RFC3339), got["resetsAt"])
}

func TestIssueActions_ForgeDown_Answers502WithAPlainReason(t *testing.T) {
	t.Parallel()

	source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: assert.AnError}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postIssueAction(t, srvURL, cookie, "close", issuePayload(nil))
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadGateway, resp.StatusCode)
	var got map[string]any
	require.NoError(t, readJSON(resp, &got))
	assert.Equal(t, "unknown", got["code"])
	assert.Contains(t, got["message"], "didn't answer")
}

func TestIssueActions_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	for _, action := range []string{"close", "reopen", "comment"} {
		t.Run(action, func(t *testing.T) {
			t.Parallel()

			source := &fakeSourceWithoutCloseSupport{forge: dashboard.ForgeGitHub}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := postIssueAction(t, srvURL, cookie, action, issuePayload(map[string]any{"body": "hi"}))
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
}

func TestIssueActions_MalformedFullNameOrUnknownForge_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	for name, extra := range map[string]map[string]any{
		"full name": {"fullName": "no-slash"},
		"forge":     {"forge": "forgejo"},
	} {
		resp := postIssueAction(t, srvURL, cookie, "close", issuePayload(extra))
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, name)
		_ = resp.Body.Close()
	}
	assert.Empty(t, source.calls)
}

func TestIssueActions_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeIssueActionsSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	for _, action := range []string{"close", "reopen", "comment"} {
		body, err := json.Marshal(issuePayload(map[string]any{"body": "hi"}))
		require.NoError(t, err)
		resp, err := testClient(t).Post(srvURL+"/api/issues/"+action, "application/json", strings.NewReader(string(body)))
		require.NoError(t, err)
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, action)
		_ = resp.Body.Close()
	}
}
