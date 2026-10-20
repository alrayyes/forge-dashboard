package api

import "github.com/alrayyes/forge-dashboard/internal/dashboard"

// boardWebBase is the web address profile pages hang off for a dialog about
// fullName on forge, taken from an item the user's board already holds. An
// item of the same repository is exact. Failing that, the first item of that
// kind of forge is used: right with one forge of a kind, which is the usual
// setup, and a known limit with two self-hosted forges of the same kind and a
// dialog for a repository the board lists nothing in. Empty when the board has
// nothing for the forge yet, in which case a person is shown by name alone.
func boardWebBase(deps Deps, userID []byte, forge dashboard.Forge, fullName string) string {
	snapshot := deps.Manager.Get(userID)
	var fallback string
	consider := func(itemForge dashboard.Forge, repo, itemURL string) (exact string) {
		if itemForge != forge {
			return ""
		}
		base := dashboard.WebBase(itemURL, repo)
		if base == "" {
			return ""
		}
		if repo == fullName {
			return base
		}
		if fallback == "" {
			fallback = base
		}

		return ""
	}
	for _, pr := range snapshot.PullRequests {
		if base := consider(pr.Forge, pr.Repo, pr.URL); base != "" {
			return base
		}
	}
	for _, issue := range snapshot.Issues {
		if base := consider(issue.Forge, issue.Repo, issue.URL); base != "" {
			return base
		}
	}

	return fallback
}

// linkCommenters gives each comment's author a profile page. It copies the
// person rather than writing through the pointer, which a source may share.
func linkCommenters(comments []dashboard.DetailsComment, forge dashboard.Forge, base string) {
	for i := range comments {
		author := comments[i].Author
		if author == nil {
			continue
		}
		linked := *author
		linked.URL = dashboard.ProfileURL(forge, base, linked.Login)
		comments[i].Author = &linked
	}
}
