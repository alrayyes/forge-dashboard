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
	"get_dashboard":             "getDashboard",
	"get_main_branches":         "getMainBranches",
	"get_main_branch_checks":    "getMainBranchChecks",
	"get_check_log":             "getCheckLog",
	"get_repository_advisories": "listAdvisories",
	"get_pull_request_details":  "getPullRequestDetails",
	"get_pull_request_checks":   "getPullRequestChecks",
	"list_queued_actions":       "listQueuedActions",
	"get_version":               "getVersion",
	"get_forge_api_stats":       "getForgeApiStats",
	"get_settings":              "getSettingsSummary",

	"set_pull_request_auto_update": "setPullRequestAutoUpdate",
}

// mcpPending are the operations whose tool is still to come, in small pull
// requests one resource at a time (#1503). A pull request that adds a tool moves
// its operation from here to mcpToolOperations; the parity test refuses both.
var mcpPending = []string{
	"getSession",
	"listCredentials",
	"deleteCredential",
	"renameCredential",
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
	"enableRebaseBots",
	"disableRebaseBots",
	"mergePullRequest",
	"enablePullRequestAutoMerge",
	"cancelPullRequestAutoMerge",
	"closePullRequest",
	"reopenPullRequest",
	"closeIssue",
	"reopenIssue",
	"commentOnIssue",
	"rerunPullRequestChecks",
	"rerunMainBranchChecks",
	"cancelWorkflowRun",
	"hidePullRequest",
	"unhidePullRequest",
	"updatePullRequestBranch",
	"postPullRequestDependabotAction",
	"postPullRequestRenovateRebase",
	"cancelPullRequestRenovateRebase",
	"queueAction",
	"cancelQueuedAction",
	"refreshDashboard",
}
