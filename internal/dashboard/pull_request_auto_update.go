package dashboard

import "strconv"

// AutoUpdateSource says where a pull request's automatic-update choice comes
// from. Matches components.schemas.AutoUpdate.source.
type AutoUpdateSource string

// The places a pull request's choice can come from.
const (
	// AutoUpdateFromRepo means the pull request has no choice of its own and
	// follows its repo's setting.
	AutoUpdateFromRepo AutoUpdateSource = "repo"
	// AutoUpdateFromPullRequest means the user set it for this pull request.
	AutoUpdateFromPullRequest AutoUpdateSource = "pullRequest"
)

// The reasons a switch for automatic updates would do nothing. Matches
// components.schemas.AutoUpdateUnavailable.code.
const (
	AutoUpdateDraft         = "draft"
	AutoUpdateReleasePlease = "release_please"
)

// AutoUpdateUnavailable is why the dashboard never updates this pull request on
// its own, whatever the user picks.
type AutoUpdateUnavailable struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

// AutoUpdate is what a pull request says about the dashboard bringing its
// branch up to date on its own. Matches components.schemas.AutoUpdate.
type AutoUpdate struct {
	// Enabled is what the background pass does: false whenever Unavailable is
	// set.
	Enabled bool             `json:"enabled"`
	Source  AutoUpdateSource `json:"source"`
	// Unavailable is set when the pass skips this pull request however it is
	// switched, so a client shows the reason instead of a switch that does
	// nothing.
	Unavailable *AutoUpdateUnavailable `json:"unavailable"`
}

// PullRequestAutoUpdate works out pr's automatic-update state: its own choice
// if it has one, else its repo's setting, and nothing at all for the pull
// requests the background pass never touches: a draft (its branch is still being
// worked on) and a release-please pull request (it rewrites its own branch with
// every release). The pass uses it too, so what a client shows is what runs.
func PullRequestAutoUpdate(pr PullRequest, repoEnabled bool, own *bool) AutoUpdate {
	state := AutoUpdate{Enabled: repoEnabled, Source: AutoUpdateFromRepo}
	if own != nil {
		state.Enabled = *own
		state.Source = AutoUpdateFromPullRequest
	}

	switch {
	case pr.Draft:
		state.Enabled = false
		state.Unavailable = &AutoUpdateUnavailable{Code: AutoUpdateDraft, Reason: "A draft pull request is never updated automatically: its branch is still being worked on."}
	case isReleasePleasePR(pr):
		state.Enabled = false
		state.Unavailable = &AutoUpdateUnavailable{Code: AutoUpdateReleasePlease, Reason: "A release-please pull request is never updated automatically: release-please rewrites its own branch with every release."}
	}

	return state
}

// autoUpdateWanted is whether the background pass should bring pr up to date:
// PullRequestAutoUpdate's answer, from the repos the user enabled and the pull
// requests they chose for.
func autoUpdateWanted(pr PullRequest, enabledRepos map[string]struct{}, overrides map[string]bool) bool {
	_, repoEnabled := enabledRepos[string(pr.Forge)+"/"+pr.Repo]
	var own *bool
	if v, ok := overrides[string(pr.Forge)+"/"+pr.Repo+"#"+strconv.Itoa(pr.Number)]; ok {
		own = &v
	}

	return PullRequestAutoUpdate(pr, repoEnabled, own).Enabled
}
