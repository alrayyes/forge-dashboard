package dashboard

// ForgeCapabilities is what one forge can do, as data. Code past the adapters
// asks this instead of testing the forge's name, so a third forge is one more
// entry in capabilitiesByForge and no new branches. Matches
// components.schemas.ForgeCapabilities.
type ForgeCapabilities struct {
	// AutoMergeHeldByApp is true when this app, not the forge, holds an armed
	// auto-merge and performs the merge once checks pass.
	AutoMergeHeldByApp bool `json:"autoMergeHeldByApp"`
	// ChecksViaWebhook is true when the forge's check events arrive by webhook,
	// so a pending run is polled only when no event came. False means a run's
	// result must be polled for.
	ChecksViaWebhook bool `json:"checksViaWebhook"`
	// ServesRunningLog is true when a job's log can be read while it runs.
	ServesRunningLog bool `json:"servesRunningLog"`
	// ServerLogExcerpts is true when the failed-job excerpt is read from the
	// log endpoint, not carried on the check list.
	ServerLogExcerpts bool `json:"serverLogExcerpts"`
	// ApprovalGatedRuns is true when a run can be held until a person approves
	// it.
	ApprovalGatedRuns bool `json:"approvalGatedRuns"`
	// DependabotCommands is true when a "@dependabot" comment does anything.
	DependabotCommands bool `json:"dependabotCommands"`
	// AdvisorySource names where the repository advisories come from.
	AdvisorySource string `json:"advisorySource"`
	// StatusPageURL is the forge's public status page, or empty when it has none.
	StatusPageURL string `json:"statusPageUrl"`
	// RateLimitModel names how the forge budgets requests.
	RateLimitModel string `json:"rateLimitModel"`
	// IssueRefSyntax names the forms the forge's text uses to reference an issue.
	IssueRefSyntax string `json:"issueRefSyntax"`
	// Label is the forge's name as a person reads it.
	Label string `json:"label"`
}

// Values of ForgeCapabilities.AdvisorySource, RateLimitModel and IssueRefSyntax.
// Open lists in the API: a new forge may add one.
const (
	AdvisorySourceDependabot = "dependabot"
	AdvisorySourceOSV        = "osv"

	RateLimitGraphQLAndREST = "graphql_and_rest"
	RateLimitRESTOnly       = "rest"

	IssueRefHash         = "hash"
	IssueRefHashOrGHPref = "hash_or_gh_prefix"
)

// capabilitiesByForge is the one place a forge's abilities are written down.
var capabilitiesByForge = map[Forge]ForgeCapabilities{
	ForgeGitHub: {
		AutoMergeHeldByApp: false,
		ChecksViaWebhook:   true,
		ServesRunningLog:   false,
		ServerLogExcerpts:  false,
		ApprovalGatedRuns:  true,
		DependabotCommands: true,
		AdvisorySource:     AdvisorySourceDependabot,
		StatusPageURL:      "https://www.githubstatus.com/",
		RateLimitModel:     RateLimitGraphQLAndREST,
		IssueRefSyntax:     IssueRefHashOrGHPref,
		Label:              "GitHub",
	},
	ForgeForgejo: {
		AutoMergeHeldByApp: true,
		ChecksViaWebhook:   false,
		ServesRunningLog:   true,
		ServerLogExcerpts:  true,
		ApprovalGatedRuns:  false,
		DependabotCommands: false,
		AdvisorySource:     AdvisorySourceOSV,
		StatusPageURL:      "",
		RateLimitModel:     RateLimitRESTOnly,
		IssueRefSyntax:     IssueRefHash,
		Label:              "Forgejo",
	},
}

// CapabilitiesOf is what forge can do. False for a forge this build doesn't know.
func CapabilitiesOf(forge Forge) (ForgeCapabilities, bool) {
	c, ok := capabilitiesByForge[forge]

	return c, ok
}

// WithCapabilities returns a copy of forges with each entry's capabilities
// filled in, for a response. The input is left as it was.
func WithCapabilities(forges []ForgeHealth) []ForgeHealth {
	out := make([]ForgeHealth, len(forges))
	for i, f := range forges {
		f.Capabilities, _ = CapabilitiesOf(f.Forge)
		out[i] = f
	}

	return out
}
