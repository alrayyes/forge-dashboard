package api

// Which API operations an MCP tool stands for (#1503). Every operationId in
// api/openapi.yaml is in exactly one of the three lists below, which
// TestMCPParity_* checks against the spec and against what the server serves.

// mcpToolOperations maps each registered MCP tool to the operation it covers.
var mcpToolOperations = map[string]string{
	"get_dashboard": "getDashboard",
}

// mcpExcluded are the operations that deliberately have no MCP tool, each with
// its reason. An MCP client signs in with a personal API token, so anything that
// is about signing in, or that a token must not do to itself, is left out.
var mcpExcluded = map[string]string{ // #nosec G101 -- operation names and reasons, no credentials
	"getRegistrationStatus": "Pre-login: reports whether self-registration is open. An MCP client already has a token.",
	"beginRegistration":     "A WebAuthn ceremony that needs a browser authenticator; a token cannot take part.",
	"finishRegistration":    "The second half of the WebAuthn registration ceremony.",
	"beginLogin":            "A WebAuthn ceremony that needs a browser authenticator.",
	"finishLogin":           "The second half of the WebAuthn login ceremony.",
	"logout":                "Ends a browser session; an MCP client's token is not that session.",
	"beginAddCredential":    "A WebAuthn ceremony that needs a browser authenticator.",
	"finishAddCredential":   "The second half of adding a passkey.",
	"listAPITokens":         "A token must not enumerate, mint or revoke tokens: one leaked token would otherwise keep itself alive by minting others.",
	"createAPIToken":        "A token must not mint tokens (see listAPITokens).",
	"deleteAPIToken":        "A token must not revoke tokens (see listAPITokens).",
	"receiveGitHubWebhook":  "A signed callback from GitHub, authenticated by its signature, not by a user.",
	"receiveForgejoWebhook": "A signed callback from Forgejo, authenticated by its signature, not by a user.",
	"health":                "A liveness probe for the orchestrator.",
	"ready":                 "A readiness probe for the orchestrator.",
	"streamDashboard":       "A server-sent event stream; a tool call answers once. get_dashboard covers the data.",
}

// mcpPending are the operations whose tool is still to come, in small pull
// requests one resource at a time (#1503). A pull request that adds a tool moves
// its operation from here to mcpToolOperations; the parity test refuses both.
var mcpPending = []string{
	"getSession",
	"listCredentials",
	"deleteCredential",
	"getSettings",
	"putSettings",
	"getTheme",
	"setTheme",
	"getTimezone",
	"setTimezone",
	"getFilterState",
	"setFilterState",
	"ensureWebhook",
	"ignoreRepo",
	"unignoreRepo",
	"enableAutoUpdateBranch",
	"disableAutoUpdateBranch",
	"mergePullRequest",
	"enablePullRequestAutoMerge",
	"cancelPullRequestAutoMerge",
	"closePullRequest",
	"rerunPullRequestChecks",
	"hidePullRequest",
	"unhidePullRequest",
	"updatePullRequestBranch",
	"postPullRequestDependabotAction",
	"postPullRequestRenovateRebase",
	"getPullRequestChecks",
	"listQueuedActions",
	"queueAction",
	"cancelQueuedAction",
	"listUsers",
	"revokeUser",
	"deleteUser",
	"createInvite",
	"listInvites",
	"revokeInvite",
	"listRequests",
	"exportRequests",
	"getVersion",
	"refreshDashboard",
	"getMainBranches",
	"getSharing",
	"shareWith",
	"unshareWith",
}
