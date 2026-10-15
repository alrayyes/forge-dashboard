package api

// Which API operations an MCP tool stands for (#1503). Every operationId in
// api/openapi.yaml is in exactly one of three places, which TestMCPParity_*
// checks against the spec and against what the server serves: a registered tool
// (mcpToolOperations below), an `x-mcp-excluded: <reason>` extension on the
// operation in the spec itself (sign-in ceremonies, token management, webhook
// receivers, probes, cookie-only operations), or the list of tools still to come
// (mcpPending below).

// mcpToolOperations maps each registered MCP tool to the operation it covers.
var mcpToolOperations = map[string]string{
	"get_dashboard":     "getDashboard",
	"get_main_branches": "getMainBranches",
}

// mcpPending are the operations whose tool is still to come, in small pull
// requests one resource at a time (#1503). A pull request that adds a tool moves
// its operation from here to mcpToolOperations; the parity test refuses both.
var mcpPending = []string{
	"getPullRequestDetails",
	"getSession",
	"listCredentials",
	"deleteCredential",
	"getSettings",
	"putSettings",
	"getTheme",
	"setTheme",
	"getTimezone",
	"setTimezone",
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
	"getSharing",
	"shareWith",
	"unshareWith",
}
