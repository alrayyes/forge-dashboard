package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// refusalSource implements every pull request write the five actions use
// plus the state re-read, and refuses each of them with err — enough to
// drive every endpoint's refusal path through one table.
type refusalSource struct {
	forge      dashboard.Forge
	err        error
	state      dashboard.PullRequestState
	stateErr   error
	stateReads int
	// blocked is what DependabotCommandsBlockedReason answers.
	blocked string
}

func (f *refusalSource) Forge() dashboard.Forge { return f.forge }

func (f *refusalSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *refusalSource) ClosePullRequest(_ context.Context, _, _ string, _ int) error { return f.err }

func (f *refusalSource) UpdateBranch(_ context.Context, _, _ string, _ int) (bool, error) {
	return false, f.err
}

func (f *refusalSource) EnableAutoMerge(_ context.Context, _, _ string, _ int) error { return f.err }

func (f *refusalSource) CommentPullRequest(_ context.Context, _, _ string, _ int, _ string) error {
	return f.err
}

func (f *refusalSource) AddLabel(_ context.Context, _, _ string, _ int, _ string) error {
	return f.err
}

func (f *refusalSource) DependabotCommandsBlockedReason() string { return f.blocked }

func (f *refusalSource) ReadPullRequestState(_ context.Context, _, _ string, _ int) (dashboard.PullRequestState, error) {
	f.stateReads++

	return f.state, f.stateErr
}

type actionEndpoint struct {
	name string
	path string
	body map[string]any
}

var refusableEndpoints = []actionEndpoint{
	{"close", "/api/pull-requests/close", nil},
	{"update-branch", "/api/pull-requests/update-branch", nil},
	{"auto-merge", "/api/pull-requests/auto-merge", nil},
	{"dependabot-action", "/api/pull-requests/dependabot-action", map[string]any{"action": "rebase"}},
	{"renovate-rebase", "/api/pull-requests/renovate-rebase", nil},
}

func postAction(t *testing.T, srvURL string, cookie *http.Cookie, ep actionEndpoint, forge string) (int, actionErrorBody) {
	t.Helper()
	payload := map[string]any{"forge": forge, "fullName": "alrayyes/a", "number": 1}
	maps.Copy(payload, ep.body)
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+ep.path, strings.NewReader(string(raw)))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))

	return resp.StatusCode, body
}

func endpointFor(name string) actionEndpoint {
	for _, ep := range refusableEndpoints {
		if ep.name == name {
			return ep
		}
	}
	panic("no endpoint " + name)
}

// Every action answers a PR the forge reports merged or closed with the
// same code, whatever text the forge refused with. The texts are the ones
// each forge really sends: Forgejo's close on a merged PR is a 400 whose
// message says so, GitHub's refusals are generic validation errors.
func TestPullRequestActions_RefusedOnAMergedOrClosedPR_AnswerTheStaleCode(t *testing.T) {
	t.Parallel()

	forgejoClose := mergeRefusal(dashboard.ForgeErrorUnknown, "forgejo: PATCH /repos/alrayyes/a/pulls/1: cannot change state of this pull request, it was already merged")
	validation := mergeRefusal(dashboard.ForgeErrorUnknown, "github: PUT /repos/alrayyes/a/pulls/1/update-branch: Validation Failed")
	cases := []struct {
		endpoint string
		forge    dashboard.Forge
		err      error
		state    dashboard.PullRequestState
		code     string
	}{
		{"close", dashboard.ForgeForgejo, forgejoClose, dashboard.PullRequestState{Merged: true, Closed: true}, "already_merged"},
		{"close", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Merged: true, Closed: true}, "already_merged"},
		{"close", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Closed: true}, "already_closed"},
		{"update-branch", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Merged: true, Closed: true}, "already_merged"},
		{"update-branch", dashboard.ForgeForgejo, validation, dashboard.PullRequestState{Closed: true}, "already_closed"},
		{"auto-merge", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Merged: true, Closed: true}, "already_merged"},
		{"auto-merge", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Closed: true}, "already_closed"},
		{"dependabot-action", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Merged: true, Closed: true}, "already_merged"},
		{"dependabot-action", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Closed: true}, "already_closed"},
		{"renovate-rebase", dashboard.ForgeForgejo, validation, dashboard.PullRequestState{Merged: true, Closed: true}, "already_merged"},
		{"renovate-rebase", dashboard.ForgeGitHub, validation, dashboard.PullRequestState{Closed: true}, "already_closed"},
	}
	for _, tc := range cases {
		t.Run(tc.endpoint+"/"+string(tc.forge)+"/"+tc.code, func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{forge: tc.forge, err: tc.err, state: tc.state}
			srvURL, cookie := newTestServerForWebhookEnsure(t, tc.forge, source)

			status, body := postAction(t, srvURL, cookie, endpointFor(tc.endpoint), string(tc.forge))

			assert.Equal(t, http.StatusConflict, status)
			assert.Equal(t, tc.code, body.Code)
			assert.NotEmpty(t, body.Message)
			assert.Contains(t, body.Error, tc.err.Error())
			assert.Equal(t, 1, source.stateReads)
		})
	}
}

func TestPullRequestActions_PermissionAndRateLimit_SkipTheReReadAndKeepTheirStatus(t *testing.T) {
	t.Parallel()

	reset := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	for _, ep := range refusableEndpoints {
		t.Run(ep.name+"/403", func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{forge: dashboard.ForgeGitHub, err: mergeRefusal(dashboard.ForgeErrorUnauthorized, "github: PUT x: Resource not accessible by integration")}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			status, body := postAction(t, srvURL, cookie, ep, "github")

			assert.Equal(t, http.StatusForbidden, status)
			assert.Equal(t, "permission", body.Code)
			assert.Equal(t, 0, source.stateReads)
		})
		t.Run(ep.name+"/429", func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{forge: dashboard.ForgeGitHub, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("github: PUT x: rate limit exceeded"), RateLimit: &dashboard.RateLimit{ResetsAt: reset}}}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			status, body := postAction(t, srvURL, cookie, ep, "github")

			assert.Equal(t, http.StatusTooManyRequests, status)
			assert.Equal(t, "rate_limited", body.Code)
			require.NotNil(t, body.ResetsAt)
			assert.True(t, reset.Equal(*body.ResetsAt))
			assert.Equal(t, 0, source.stateReads)
		})
		t.Run(ep.name+"/reread-fails", func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{
				forge:    dashboard.ForgeGitHub,
				err:      mergeRefusal(dashboard.ForgeErrorUnknown, "github: PUT x: Something odd"),
				stateErr: mergeRefusal(dashboard.ForgeErrorUnreachable, "github: GET x: timeout"),
			}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			status, body := postAction(t, srvURL, cookie, ep, "github")

			assert.Equal(t, http.StatusBadGateway, status)
			assert.Equal(t, "unknown", body.Code)
			assert.Equal(t, "Something odd", body.Message)
		})
		t.Run(ep.name+"/open-and-unexplained", func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{forge: dashboard.ForgeGitHub, err: mergeRefusal(dashboard.ForgeErrorUnknown, "github: PUT x: Something odd")}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			status, body := postAction(t, srvURL, cookie, ep, "github")

			assert.Equal(t, http.StatusBadGateway, status)
			assert.Equal(t, "unknown", body.Code)
			assert.Equal(t, "Something odd", body.Message)
		})
	}
}

// The merge-only rules must not leak into the other actions: a PR that is
// behind or in conflict says nothing about why Close or a label failed.
func TestPullRequestActions_MergeOnlyStateDoesNotExplainOtherActions(t *testing.T) {
	t.Parallel()

	source := &refusalSource{
		forge: dashboard.ForgeGitHub,
		err:   mergeRefusal(dashboard.ForgeErrorUnknown, "github: PATCH x: Something odd"),
		state: dashboard.PullRequestState{Conflicting: true, Behind: true, Draft: true},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	_, body := postAction(t, srvURL, cookie, endpointFor("close"), "github")

	assert.Equal(t, "unknown", body.Code)
}

func TestPullRequestUpdateBranch_Refusals(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		forge  dashboard.Forge
		err    error
		state  dashboard.PullRequestState
		status int
		code   string
	}{
		{
			"github 422 on conflict (mapped to conflict by #702)", dashboard.ForgeGitHub,
			mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT /repos/alrayyes/a/pulls/1/update-branch: merge conflict between base and head"),
			dashboard.PullRequestState{Conflicting: true},
			http.StatusConflict, "conflict",
		},
		{
			"forgejo 409 on conflict", dashboard.ForgeForgejo,
			mergeRefusal(dashboard.ForgeErrorConflict, "forgejo: POST /repos/alrayyes/a/pulls/1/update: merge failed because of conflict"),
			dashboard.PullRequestState{},
			http.StatusConflict, "conflict",
		},
		{
			"github nothing to bring in", dashboard.ForgeGitHub,
			mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT /repos/alrayyes/a/pulls/1/update-branch: There are no new commits on the base branch."),
			dashboard.PullRequestState{},
			http.StatusConflict, "already_up_to_date",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{forge: tc.forge, err: tc.err, state: tc.state}
			srvURL, cookie := newTestServerForWebhookEnsure(t, tc.forge, source)

			status, body := postAction(t, srvURL, cookie, endpointFor("update-branch"), string(tc.forge))

			assert.Equal(t, tc.status, status)
			assert.Equal(t, tc.code, body.Code)
			assert.NotEmpty(t, body.Message)
		})
	}
}

func TestPullRequestUpdateBranch_ConflictIsAnsweredEvenWhenTheReReadFails(t *testing.T) {
	t.Parallel()

	source := &refusalSource{
		forge:    dashboard.ForgeGitHub,
		err:      mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT x: merge conflict between base and head"),
		stateErr: mergeRefusal(dashboard.ForgeErrorUnreachable, "github: GET x: timeout"),
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, body := postAction(t, srvURL, cookie, endpointFor("update-branch"), "github")

	assert.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "conflict", body.Code)
}

func TestPullRequestAutoMerge_Refusals(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		text string
		code string
	}{
		{"repo disallows it", "Auto merge is not allowed for this repository", "auto_merge_not_allowed"},
		{"already clean (#662)", "Pull request is in clean status", "ready_to_merge"},
		{"unstable (#621)", "Pull request is in unstable status", "checks_pending"},
		{"no protection rule", "Protected branch rules not configured for this branch", "blocked_by_protection"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			source := &refusalSource{forge: dashboard.ForgeGitHub, err: mergeRefusal(dashboard.ForgeErrorUnknown, "github: graphql: "+tc.text)}
			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			status, body := postAction(t, srvURL, cookie, endpointFor("auto-merge"), "github")

			assert.Equal(t, http.StatusBadGateway, status)
			assert.Equal(t, tc.code, body.Code)
			assert.NotEmpty(t, body.Message)
		})
	}
}

func TestPullRequestRenovateRebase_MissingLabelOnAnOpenPR_AnswersLabelMissing(t *testing.T) {
	t.Parallel()

	source := &refusalSource{
		forge: dashboard.ForgeForgejo,
		err:   mergeRefusal(dashboard.ForgeErrorNotFound, `forgejo: no label "rebase" on alrayyes/a — create it on the repo first`),
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	status, body := postAction(t, srvURL, cookie, endpointFor("renovate-rebase"), "forgejo")

	assert.Equal(t, http.StatusNotFound, status)
	assert.Equal(t, "label_missing", body.Code)
	assert.Contains(t, body.Message, "rebase")
}

func TestPullRequestDependabotAction_BlockedAppAnswersPermissionWithTheReason(t *testing.T) {
	t.Parallel()

	source := &refusalSource{forge: dashboard.ForgeGitHub, blocked: "Dependabot ignores GitHub Apps"}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, body := postAction(t, srvURL, cookie, endpointFor("dependabot-action"), "github")

	assert.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "permission", body.Code)
	assert.Equal(t, "Dependabot ignores GitHub Apps", body.Message)
	assert.Equal(t, "Dependabot ignores GitHub Apps", body.Error)
}
