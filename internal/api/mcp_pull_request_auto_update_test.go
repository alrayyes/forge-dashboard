package api_test

import (
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The set_pull_request_auto_update tool and POST /api/v1/pull-requests/auto-update
// share one function, so these tests pin the tool's wiring and its refusals;
// pull_request_auto_update_test.go holds the behaviour behind both.

func callSetAutoUpdate(t *testing.T, srvURL, token string, args map[string]any) *mcp.CallToolResult {
	t.Helper()

	session := connectMCP(t, srvURL, token)
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "set_pull_request_auto_update", Arguments: args})
	require.NoError(t, err)

	return result
}

func toolText(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()

	require.NotEmpty(t, result.Content)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok)

	return text.Text
}

func TestMCP_SetPullRequestAutoUpdate_ListsTheToolAndSaysItWritesOnlyLocally(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, true)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	list, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	var found *mcp.Tool
	for _, tool := range list.Tools {
		if tool.Name == "set_pull_request_auto_update" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"only this app's own setting", "never writes to either forge", "follows its repo", "enabled"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_SetPullRequestAutoUpdate_OptingOutShowsInTheDashboardAsAPullRequestChoice(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, true)
	token := createAPIToken(t, srvURL, cookie)

	result := callSetAutoUpdate(t, srvURL, token, map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1, "enabled": false})

	require.False(t, result.IsError, "%v", result.Content)
	got := autoUpdateStates(t, srvURL, cookie)
	assert.Equal(t, false, got[1]["enabled"])
	assert.Equal(t, "pullRequest", got[1]["source"])
	assert.Equal(t, "repo", got[2]["source"], "the other pull requests still follow the repo")
}

func TestMCP_SetPullRequestAutoUpdate_AChoiceEqualToTheRepoIsDroppedAndNullFollowsTheRepoAgain(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, true)
	token := createAPIToken(t, srvURL, cookie)
	callSetAutoUpdate(t, srvURL, token, map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1, "enabled": false})

	same := callSetAutoUpdate(t, srvURL, token, map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 2, "enabled": true})
	require.False(t, same.IsError)
	assert.Equal(t, "repo", autoUpdateStates(t, srvURL, cookie)[2]["source"], "true equals the repo, so nothing is kept")

	for _, args := range []map[string]any{
		{"forge": "github", "fullName": "alrayyes/a", "number": 1, "enabled": nil},
	} {
		back := callSetAutoUpdate(t, srvURL, token, args)
		require.False(t, back.IsError)
	}
	assert.Equal(t, "repo", autoUpdateStates(t, srvURL, cookie)[1]["source"])

	absent := callSetAutoUpdate(t, srvURL, token, map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1})
	require.False(t, absent.IsError, "an absent enabled follows the repo, like null")
}

func TestMCP_SetPullRequestAutoUpdate_RefusesANonBooleanEnabled(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, true)
	token := createAPIToken(t, srvURL, cookie)

	result := callSetAutoUpdate(t, srvURL, token, map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1, "enabled": "yes"})

	require.True(t, result.IsError)
	assert.Equal(t, "repo", autoUpdateStates(t, srvURL, cookie)[1]["source"], "nothing was saved")
}

func TestMCP_SetPullRequestAutoUpdate_RefusesWhatTheEndpointRefuses(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, true)
	token := createAPIToken(t, srvURL, cookie)

	tests := map[string]struct {
		args map[string]any
		want string
	}{
		"a pull request the dashboard does not hold": {map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 99, "enabled": true}, "pull request not found"},
		"a repository that is not owner/repo":        {map[string]any{"forge": "github", "fullName": "nope", "number": 1, "enabled": true}, `fullName must be "owner/repo"`},
		"an unknown forge":                           {map[string]any{"forge": "gitlab", "fullName": "alrayyes/a", "number": 1, "enabled": true}, "forge must be github or forgejo"},
		"a number that is not positive":              {map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 0, "enabled": true}, "number must be a pull request number"},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			result := callSetAutoUpdate(t, srvURL, token, tc.args)

			require.True(t, result.IsError)
			assert.Contains(t, toolText(t, result), tc.want)
		})
	}
}
