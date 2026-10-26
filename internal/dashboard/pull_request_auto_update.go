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
//
// botRebased names the open bot pull requests a rebase-bots repo covers. The
// repo setting is effectively on for them, so a choice of false differs from it
// and is kept.
func staleAutoUpdateChoices(snap Snapshot, enabledRepos map[string]struct{}, overrides map[string]bool, botRebased map[string]struct{}) []string {
	open := make(map[string]struct{}, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		open[autoUpdateKey(pr.Forge, pr.Repo, pr.Number)] = struct{}{}
	}
	reachable := make(map[Forge]bool, len(snap.Forges))
	for _, f := range snap.Forges {
		reachable[f.Forge] = f.Reachable
	}

	// A repo whose fetch failed is still listed, marked stale. Its missing
	// pull requests say nothing about whether they are gone, and on the first
	// refresh after a restart there is no earlier snapshot to carry them over
	// from.
	failed := make(map[string]struct{})
	for _, r := range snap.Repos {
		if r.StaleSince != nil {
			failed[string(r.Forge)+"/"+r.FullName] = struct{}{}
		}
	}

	var stale []string
	for key, own := range overrides {
		forge, repo, ok := splitAutoUpdateKey(key)
		if !ok {
			continue
		}
		_, repoEnabled := enabledRepos[string(forge)+"/"+repo]
		_, isOpen := open[key]
		_, repoFailed := failed[string(forge)+"/"+repo]
		switch {
		case !isOpen && reachable[forge] && !repoFailed:
			stale = append(stale, key)
		case isOpen && own == repoEnabled && !inSet(botRebased, key):
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

func inSet(set map[string]struct{}, key string) bool {
	_, ok := set[key]

	return ok
}

// isBotPR is whether pr is one the bot's own rebase command covers.
func isBotPR(pr PullRequest, renovateAuthors []string) bool {
	return isDependabotPR(pr) || isRenovatePR(pr, renovateAuthors)
}

// autoUpdateWantedWithBots is autoUpdateWanted, except that a Dependabot or
// Renovate pull request in a repo set to rebase bots counts as enabled there.
// The pull request's own choice still wins, and draft and release-please pull
// requests stay out, because PullRequestAutoUpdate decides both.
func autoUpdateWantedWithBots(pr PullRequest, enabledRepos, rebaseBots map[string]struct{}, overrides map[string]bool, renovateAuthors []string) bool {
	repo := string(pr.Forge) + "/" + pr.Repo
	if inSet(rebaseBots, repo) && isBotPR(pr, renovateAuthors) {
		enabledRepos = map[string]struct{}{repo: {}}
	}

	return autoUpdateWanted(pr, enabledRepos, overrides)
}

// botRebaseKeys names the pull requests in snap that a rebase-bots repo covers.
func botRebaseKeys(snap Snapshot, rebaseBots map[string]struct{}, renovateAuthors []string) map[string]struct{} {
	keys := make(map[string]struct{})
	for _, pr := range snap.PullRequests {
		if inSet(rebaseBots, string(pr.Forge)+"/"+pr.Repo) && isBotPR(pr, renovateAuthors) {
			keys[autoUpdateKey(pr.Forge, pr.Repo, pr.Number)] = struct{}{}
		}
	}

	return keys
}
