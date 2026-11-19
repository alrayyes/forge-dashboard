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
	// AdvisoryUnknownNeedsReason is true when an "unknown" advisory answer is
	// worth saying only if the server names a reason. Without one it usually
	// means a repository with nothing to check, so a client stays quiet.
	AdvisoryUnknownNeedsReason bool `json:"advisoryUnknownNeedsReason"`
	// ReportsRepoPermissions is true when the forge sends the signed-in user's
	// permissions with each repo it lists, so a repo that arrives without them
	// is the forge's omission and says nothing about the user's role. False
	// when the dashboard finds out by trying the endpoint instead.
	ReportsRepoPermissions bool `json:"reportsRepoPermissions"`
	// StatusPageURL is the forge's public status page, or empty when it has none.
	StatusPageURL string `json:"statusPageUrl"`
	// RateLimitModel names how the forge budgets requests.
	RateLimitModel string `json:"rateLimitModel"`
	// RateLimitDocsURL is the forge's published rules for its request budget,
	// or empty when it has none to link to.
	RateLimitDocsURL string `json:"rateLimitDocsUrl"`
	// IssueRefSyntax names the forms the forge's text uses to reference an issue.
	IssueRefSyntax string `json:"issueRefSyntax"`
	// Label is the forge's name as a person reads it.
	Label string `json:"label"`
	// ImageHosts are the fixed public hosts an image embedded in the forge's
	// text may come from, matched by exact name over https and fetched without
	// the token. Empty means the forge's own saved instance, the one place its
	// token goes. Never nil, so the API sends a list.
	ImageHosts []string `json:"imageHosts"`
	// AvatarHosts are further fixed hosts only avatars and repository logos
	// load from. Empty for a forge whose avatars live on its own instance.
	AvatarHosts []string `json:"avatarHosts"`
	// SignedAttachmentPrefix is the address prefix of an attachment the forge
	// serves only at a signed link found in the item's rendered body, or empty
	// when it has none. The server then looks that link up before fetching.
	SignedAttachmentPrefix string `json:"signedAttachmentPrefix"`
	// BotLoginSuffix is what the forge appends to a bot account's login
	// ("[bot]" on GitHub), or empty when it has no bot accounts of this kind.
	// Server-side only: profile links are built here, so it is not in the API.
	BotLoginSuffix string `json:"-"`
	// BotProfilePages maps a bot's login, without BotLoginSuffix, to the path
	// of its page under the forge's web base. A bot not listed has no page that
	// was checked to exist, and is shown by name alone. Server-side only.
	BotProfilePages map[string]string `json:"-"`
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
		AutoMergeHeldByApp:         false,
		ChecksViaWebhook:           true,
		ServesRunningLog:           false,
		ServerLogExcerpts:          false,
		ApprovalGatedRuns:          true,
		DependabotCommands:         true,
		AdvisorySource:             AdvisorySourceDependabot,
		AdvisoryUnknownNeedsReason: false,
		ReportsRepoPermissions:     false,
		StatusPageURL:              "https://www.githubstatus.com/",
		RateLimitModel:             RateLimitGraphQLAndREST,
		RateLimitDocsURL:           "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
		IssueRefSyntax:             IssueRefHashOrGHPref,
		Label:                      "GitHub",
		// An image in a pull request, issue or release comes from GitHub's
		// attachment route and the user-content hosts it redirects to. A public
		// gist's raw files live on another (#3888). Nothing else is fetched
		// (#3405).
		ImageHosts: []string{
			"github.com",
			"user-images.githubusercontent.com",
			"private-user-images.githubusercontent.com",
			"raw.githubusercontent.com",
			"gist.githubusercontent.com",
		},
		// Avatars and repository logos live on two more (#3467).
		AvatarHosts:            []string{"avatars.githubusercontent.com", "repository-images.githubusercontent.com"},
		SignedAttachmentPrefix: "https://github.com/user-attachments/",
		BotLoginSuffix:         "[bot]",
		// Pages checked to exist. A bot's login is not its page: Dependabot's
		// is an organisation at /dependabot (/apps/dependabot only lands on a
		// docs page), Renovate's is its app page (/renovate is a 404). GitHub
		// Actions and the rest have no page that is theirs, and a missing
		// link beats a dead one.
		BotProfilePages: map[string]string{
			"dependabot": "dependabot",
			"renovate":   "apps/renovate",
		},
	},
	ForgeForgejo: {
		AutoMergeHeldByApp:         true,
		ChecksViaWebhook:           false,
		ServesRunningLog:           true,
		ServerLogExcerpts:          true,
		ApprovalGatedRuns:          false,
		DependabotCommands:         false,
		AdvisorySource:             AdvisorySourceOSV,
		AdvisoryUnknownNeedsReason: true,
		ReportsRepoPermissions:     true,
		StatusPageURL:              "",
		RateLimitModel:             RateLimitRESTOnly,
		RateLimitDocsURL:           "",
		IssueRefSyntax:             IssueRefHash,
		Label:                      "Forgejo",
		// No fixed hosts: its images come from the saved instance.
		ImageHosts:  []string{},
		AvatarHosts: []string{},
	},
}

// knownForges lists the keys of capabilitiesByForge in the order a page shows
// them. A new forge is one entry here and one in capabilitiesByForge;
// TestForges_MatchTheCapabilityTable fails if only one of them is written.
var knownForges = []Forge{ForgeGitHub, ForgeForgejo}

// Forges lists every forge this build knows, in display order. It is a copy.
func Forges() []Forge {
	return append([]Forge(nil), knownForges...)
}

// Valid is whether f is a forge this build knows. The one place a request's
// forge is checked, so a third forge needs no edit at the call sites.
func (f Forge) Valid() bool {
	_, ok := capabilitiesByForge[f]

	return ok
}

// CapabilitiesOf is what forge can do. False for a forge this build doesn't know.
func CapabilitiesOf(forge Forge) (ForgeCapabilities, bool) {
	c, ok := capabilitiesByForge[forge]

	return c, ok
}

// WithCapabilities returns a copy of forges with each entry's capabilities
// filled in, for a response. The input is left as it was. A forge the table
// doesn't know gets the zero value (an empty label), and the web falls back
// to the forge's id.
func WithCapabilities(forges []ForgeHealth) []ForgeHealth {
	out := make([]ForgeHealth, len(forges))
	for i, f := range forges {
		f.Capabilities, _ = CapabilitiesOf(f.Forge)
		out[i] = f
	}

	return out
}

// answersDependabot is true when a "@dependabot" comment on forge does
// anything. False for a forge this build doesn't know.
func answersDependabot(forge Forge) bool {
	c, _ := CapabilitiesOf(forge)

	return c.DependabotCommands
}

// AppMergesArmed is true when this app holds an armed auto-merge for forge and
// performs the merge itself. False for a forge that merges its own, and for one
// this build doesn't know.
func AppMergesArmed(forge Forge) bool {
	c, _ := CapabilitiesOf(forge)

	return c.AutoMergeHeldByApp
}

// forgeMergesArmed is the other half: a known forge that holds an armed
// auto-merge itself. Nothing this app does makes it merge.
func forgeMergesArmed(forge Forge) bool {
	c, ok := CapabilitiesOf(forge)

	return ok && !c.AutoMergeHeldByApp
}
