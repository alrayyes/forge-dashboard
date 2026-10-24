package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const seededSettings = `{"githubToken":"ghp_secret_value","githubUsername":"ryan","forgejoUrl":"https://git.example.com",` +
	`"forgejoToken":"fj_secret_value","forgejoUsername":"ryan","renovateAuthors":["renovate"],"ignoredTitles":["^Weekly"]}`

func callSettingsTool(t *testing.T, srvURL string, cookie *http.Cookie) *mcp.CallToolResult {
	t.Helper()

	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_settings"})
	require.NoError(t, err)
	require.False(t, result.IsError)

	return result
}

func settingsContent(t *testing.T, result *mcp.CallToolResult) map[string]any {
	t.Helper()

	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)

	return content
}

func TestMCP_GetSettings_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	list, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	var found *mcp.Tool
	for _, tool := range list.Tools {
		if tool.Name == "get_settings" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "webhook", "never"} {
		assert.Contains(t, found.Description, want)
	}
	props, _ := found.OutputSchema.(map[string]any)["properties"].(map[string]any)
	assert.Contains(t, props, "webhookConfigured")
	assert.NotContains(t, props, "webhookToken")
	assert.NotContains(t, props, "webhookSecret")
}

func TestMCP_GetSettings_NeverReturnsAnySecret(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, seededSettings, cookie)
	require.Equal(t, http.StatusOK, status)
	creds := getSettings(t, srv.URL, cookie) // creates the webhook credentials
	require.NotEmpty(t, creds.WebhookToken)
	require.NotEmpty(t, creds.WebhookSecret)

	result := callSettingsTool(t, srv.URL, cookie)

	structured, err := json.Marshal(result.StructuredContent)
	require.NoError(t, err)
	var all strings.Builder
	all.Write(structured)
	for _, c := range result.Content {
		text, ok := c.(*mcp.TextContent)
		require.True(t, ok)
		all.WriteString(text.Text)
	}
	for _, secret := range []string{"ghp_secret_value", "fj_secret_value", creds.WebhookToken, creds.WebhookSecret} {
		assert.NotContains(t, all.String(), secret)
	}
	content := settingsContent(t, result)
	assert.Equal(t, true, content["githubTokenSet"])
	assert.Equal(t, true, content["forgejoTokenSet"])
	assert.Equal(t, true, content["webhookConfigured"])
	assert.NotContains(t, content, "webhookToken")
	assert.NotContains(t, content, "webhookSecret")
}

func TestMCP_GetSettings_HasTheHTTPFieldsMinusTheWebhookSecrets(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, seededSettings, cookie)
	require.Equal(t, http.StatusOK, status)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", cookie)
	defer func() { _ = resp.Body.Close() }()
	var want map[string]any
	require.NoError(t, readJSON(resp, &want))
	delete(want, "webhookToken")
	delete(want, "webhookSecret")
	want["webhookConfigured"] = true

	assert.Equal(t, want, settingsContent(t, callSettingsTool(t, srv.URL, cookie)))
}

func TestMCP_GetSettings_ReadsWithoutCreatingWebhookCredentials(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	assert.Equal(t, false, settingsContent(t, callSettingsTool(t, srv.URL, cookie))["webhookConfigured"])
	assert.Equal(t, false, settingsContent(t, callSettingsTool(t, srv.URL, cookie))["webhookConfigured"],
		"a first call must not have created the credentials")

	getSettings(t, srv.URL, cookie) // the HTTP read does create them
	assert.Equal(t, true, settingsContent(t, callSettingsTool(t, srv.URL, cookie))["webhookConfigured"])
}

func TestMCP_GetSettings_EmptySettingsAreListsNotNull(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	content := settingsContent(t, callSettingsTool(t, srv.URL, cookie))
	assert.Equal(t, []any{}, content["ignoredTitles"])
	assert.Equal(t, []any{}, content["renovateAuthors"])
	assert.Equal(t, false, content["githubTokenSet"])
	assert.Empty(t, content["githubUsername"])
}

func TestMCP_GetSettings_ValidatesAgainstItsOutputSchema(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, seededSettings, cookie)
	require.Equal(t, http.StatusOK, status)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))
	list, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	var tool *mcp.Tool
	for _, c := range list.Tools {
		if c.Name == "get_settings" {
			tool = c
		}
	}
	require.NotNil(t, tool)
	raw, err := json.Marshal(tool.OutputSchema)
	require.NoError(t, err)
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(raw, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_settings"})
	require.NoError(t, err)
	require.NoError(t, resolved.Validate(settingsContent(t, result)))
}

func TestMCP_GetSettings_IgnoredTitleCountsMatchTheHTTPValue(t *testing.T) {
	t.Parallel()

	issues := []dashboard.Issue{
		countIssue(1, "a/x", "Weekly report 1"), countIssue(2, "a/x", "Weekly report 2"),
		countIssue(3, "a/x", "stale branch"), countIssue(4, "a/x", "A real bug"),
	}
	srv := countsServer(t, map[string][]dashboard.Issue{countsToken: issues})
	cookie := signInWithBoard(t, srv, 4)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["^weekly","STALE","none"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool { return getSettings(t, srv.URL, cookie).IgnoredTitleCounts[0] != nil }, pollBudget, 10*time.Millisecond)

	got := settingsContent(t, callSettingsTool(t, srv.URL, cookie))

	assert.Equal(t, []any{float64(2), float64(1), float64(0)}, got["ignoredTitleCounts"])
}

func TestMCP_GetSettings_IgnoredTitleCountsAreNullWhileUnknown(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	srv := newTestServerWithSources(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken == "" {
			return nil
		}

		return []dashboard.Source{&gatedSource{release: release, issues: []dashboard.Issue{countIssue(1, "a/x", "Weekly")}}}
	})
	t.Cleanup(func() { close(release) })
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	got := settingsContent(t, callSettingsTool(t, srv.URL, cookie))

	assert.Equal(t, []any{nil}, got["ignoredTitleCounts"])
}
