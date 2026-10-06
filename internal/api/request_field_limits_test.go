package api_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every field a client can send has a bound (#1008, OWASP API4). The spec
// states each bound and these tests hold the server to it: the spec's own
// number is what they send, so the two can't drift apart.

// requestSchema loads components.schemas[name] from the spec.
func requestSchema(t *testing.T, name string) *openapi3.Schema {
	t.Helper()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	ref, ok := doc.Components.Schemas[name]
	require.True(t, ok, "the spec has no schema %s", name)

	return ref.Value
}

// maxLength is the spec's bound for a string property.
func maxLength(t *testing.T, schema, property string) int {
	t.Helper()

	prop, ok := requestSchema(t, schema).Properties[property]
	require.True(t, ok, "%s has no property %s", schema, property)
	require.NotNil(t, prop.Value.MaxLength, "%s.%s has no maxLength", schema, property)

	return int(*prop.Value.MaxLength) //nolint:gosec // a small spec constant
}

// TestRequestSchemas_EveryFieldCarriesABound reads the spec: each string, whole
// number and list a request can carry has a limit, bar the schemas that are
// opaque on purpose (WebAuthn, the filter state), which only the body cap bounds.
func TestRequestSchemas_EveryFieldCarriesABound(t *testing.T) {
	t.Parallel()

	for _, name := range []string{
		"RegisterBeginRequest", "LoginBeginRequest", "SettingsRequest", "ThemeRequest",
		"TimezoneRequest", "APITokenCreateRequest", "WebhookEnsureRequest",
		"RepoIgnoreRequest", "PullRequestActionRequest",
		"PullRequestDependabotActionRequest", "AdminInviteCreateRequest",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			for property, ref := range requestSchema(t, name).Properties {
				switch {
				case ref.Value.Type.Is("string") && ref.Value.Format != "date-time":
					assert.NotNil(t, ref.Value.MaxLength, "%s.%s needs maxLength", name, property)
				case ref.Value.Type.Is("integer"):
					assert.NotNil(t, ref.Value.Max, "%s.%s needs maximum", name, property)
				case ref.Value.Type.Is("array"):
					assert.NotNil(t, ref.Value.MaxItems, "%s.%s needs maxItems", name, property)
				}
			}
		})
	}
}

// overField asserts resp is a 400 that names field.
func overField(t *testing.T, resp *http.Response, field string) {
	t.Helper()

	require.Equal(t, http.StatusBadRequest, resp.StatusCode)

	var body map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, field, body["field"])
}

func TestRequestFields_AStringOverItsBoundIsRefusedWithAFieldError(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, testDisplay)

	over := func(schema, property string) string {
		return strings.Repeat("a", maxLength(t, schema, property)+1)
	}
	repo := func() string { return over("WebhookEnsureRequest", "fullName") }

	for name, tc := range map[string]struct {
		method, path, body, field string
		signedIn                  bool
	}{
		"register username":     {http.MethodPost, "/api/auth/register/begin", `{"username":"` + over("RegisterBeginRequest", "username") + `","displayName":"x"}`, "username", false},
		"register display name": {http.MethodPost, "/api/auth/register/begin", `{"username":"x","displayName":"` + over("RegisterBeginRequest", "displayName") + `"}`, "displayName", false},
		"register invite token": {http.MethodPost, "/api/auth/register/begin", `{"username":"x","inviteToken":"` + over("RegisterBeginRequest", "inviteToken") + `"}`, "inviteToken", false},
		"login username":        {http.MethodPost, "/api/auth/login/begin", `{"username":"` + over("LoginBeginRequest", "username") + `"}`, "username", false},
		"invite username":       {http.MethodPost, "/api/admin/invites", `{"username":"` + over("AdminInviteCreateRequest", "username") + `","displayName":"x"}`, "username", true},
		"invite display name":   {http.MethodPost, "/api/admin/invites", `{"username":"x","displayName":"` + over("AdminInviteCreateRequest", "displayName") + `"}`, "displayName", true},
		"github token":          {http.MethodPut, "/api/settings", `{"githubToken":"` + over("SettingsRequest", "githubToken") + `"}`, "githubToken", true},
		"github username":       {http.MethodPut, "/api/settings", `{"githubUsername":"` + over("SettingsRequest", "githubUsername") + `"}`, "githubUsername", true},
		"forgejo url":           {http.MethodPut, "/api/settings", `{"forgejoUrl":"` + over("SettingsRequest", "forgejoUrl") + `"}`, "forgejoUrl", true},
		"forgejo token":         {http.MethodPut, "/api/settings", `{"forgejoUrl":"https://f.example","forgejoToken":"` + over("SettingsRequest", "forgejoToken") + `"}`, "forgejoToken", true},
		"forgejo username":      {http.MethodPut, "/api/settings", `{"forgejoUrl":"https://f.example","forgejoUsername":"` + over("SettingsRequest", "forgejoUsername") + `"}`, "forgejoUsername", true},
		"rebase label":          {http.MethodPut, "/api/settings", `{"renovateRebaseLabel":"` + over("SettingsRequest", "renovateRebaseLabel") + `"}`, "renovateRebaseLabel", true},
		"timezone":              {http.MethodPut, "/api/settings/timezone", `{"timezone":"` + over("TimezoneRequest", "timezone") + `"}`, "timezone", true},
		"api token label":       {http.MethodPost, "/api/tokens", `{"label":"` + over("APITokenCreateRequest", "label") + `","expiresAt":"2999-01-01T00:00:00Z"}`, "label", true},
		"webhook repo":          {http.MethodPost, "/api/webhooks/ensure", `{"forge":"github","fullName":"` + repo() + `/x"}`, "fullName", true},
		"ignore repo":           {http.MethodPost, "/api/repos/ignore", `{"forge":"github","fullName":"` + repo() + `/x","prs":true,"issues":false}`, "fullName", true},
		"unignore repo":         {http.MethodPost, "/api/repos/unignore", `{"forge":"github","fullName":"` + repo() + `/x"}`, "fullName", true},
		"auto update repo":      {http.MethodPost, "/api/repos/auto-update-branch/enable", `{"forge":"github","fullName":"` + repo() + `/x"}`, "fullName", true},
		"merge repo":            {http.MethodPost, "/api/pull-requests/merge", `{"forge":"github","fullName":"` + repo() + `/x","number":1}`, "fullName", true},
		"dependabot repo":       {http.MethodPost, "/api/pull-requests/dependabot-action", `{"forge":"github","fullName":"` + repo() + `/x","number":1,"action":"rebase"}`, "fullName", true},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			if !tc.signedIn {
				resp, err := http.Post(srv.URL+tc.path, "application/json", strings.NewReader(tc.body))
				require.NoError(t, err)
				defer func() { _ = resp.Body.Close() }()
				overField(t, resp, tc.field)

				return
			}
			resp := doJSON(t, tc.method, srv.URL+tc.path, tc.body, cookie)
			defer func() { _ = resp.Body.Close() }()

			overField(t, resp, tc.field)
		})
	}
}

func TestRequestFields_ANumberOverItsBoundIsRefusedWithAFieldError(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, testDisplay)

	installation := requestSchema(t, "SettingsRequest").Properties["githubAppInstallationId"].Value
	require.NotNil(t, installation.Max)
	number := requestSchema(t, "PullRequestActionRequest").Properties["number"].Value
	require.NotNil(t, number.Max)

	overInstallation := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubAppInstallationId":`+formatBound(*installation.Max+1)+`}`, cookie)
	defer func() { _ = overInstallation.Body.Close() }()
	overField(t, overInstallation, "githubAppInstallationId")

	overNumber := doJSON(t, http.MethodPost, srv.URL+"/api/pull-requests/merge", `{"forge":"github","fullName":"o/r","number":`+formatBound(*number.Max+1)+`}`, cookie)
	defer func() { _ = overNumber.Body.Close() }()
	overField(t, overNumber, "number")
}

func TestRequestFields_AStringAtItsBoundIsStillAccepted(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, testDisplay)

	resp := doJSON(t, http.MethodPost, srv.URL+"/api/admin/invites",
		`{"username":"`+strings.Repeat("a", maxLength(t, "AdminInviteCreateRequest", "username"))+`","displayName":"x"}`, cookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusCreated, resp.StatusCode)
}

// formatBound writes a spec bound as a JSON integer.
func formatBound(bound float64) string {
	return strconv.FormatFloat(bound, 'f', 0, 64)
}
