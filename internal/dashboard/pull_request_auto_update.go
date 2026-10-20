package dashboard

import (
	"slices"
	"strconv"
	"strings"
)

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
	// A choice equal to the repo's setting pins nothing: the repo may have been
	// switched to match after the choice was made, and the pull request must
	// follow it again.
	if own != nil && *own != repoEnabled {
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

// staleAutoUpdateChoices are the keys of choices the pass can forget: those of a
// pull request that is gone, and those that now equal their repo's setting.
// Nothing is gone while its forge is unreachable, since an outage returns no
// pull requests and that isn't a close. A repo that is no longer tracked has no
// pull requests in the snapshot either, so its choices go with them.
func staleAutoUpdateChoices(snap Snapshot, enabledRepos map[string]struct{}, overrides map[string]bool) []string {
	open := make(map[string]struct{}, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		open[autoUpdateKey(pr.Forge, pr.Repo, pr.Number)] = struct{}{}
	}
	reachable := make(map[Forge]bool, len(snap.Forges))
	for _, f := range snap.Forges {
		reachable[f.Forge] = f.Reachable
	}

	var stale []string
	for key, own := range overrides {
		forge, repo, ok := splitAutoUpdateKey(key)
		if !ok {
			continue
		}
		_, repoEnabled := enabledRepos[string(forge)+"/"+repo]
		_, isOpen := open[key]
		switch {
		case !isOpen && reachable[forge]:
			stale = append(stale, key)
		case isOpen && own == repoEnabled:
			stale = append(stale, key)
		}
	}
	slices.Sort(stale)

	return stale
}

// autoUpdateKey is how a pull request is named in the choices the lister
// returns: forge/owner/repo#number, settings.AutoMergeKey's form.
func autoUpdateKey(forge Forge, repo string, number int) string {
	return string(forge) + "/" + repo + "#" + strconv.Itoa(number)
}

// splitAutoUpdateKey is autoUpdateKey the other way round, as far as the
// pass needs: the forge and the "owner/repo".
func splitAutoUpdateKey(key string) (Forge, string, bool) {
	forge, rest, ok := strings.Cut(key, "/")
	if !ok {
		return "", "", false
	}
	repo, _, ok := strings.CutLast(rest, "#")

	return Forge(forge), repo, ok
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
