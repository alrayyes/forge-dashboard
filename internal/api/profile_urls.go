package api

import "github.com/alrayyes/forge-dashboard/internal/dashboard"

// boardWebOrigin is the web address (scheme and host) of forge, taken from an
// item the user's board already holds for it, so a profile link is built on the
// forge's own address rather than a guess. Empty when the board has nothing for
// the forge yet, in which case a person is shown by name alone.
func boardWebOrigin(deps Deps, userID []byte, forge dashboard.Forge) string {
	snapshot := deps.Manager.Get(userID)
	for _, pr := range snapshot.PullRequests {
		if pr.Forge != forge {
			continue
		}
		if origin := dashboard.WebOrigin(pr.URL); origin != "" {
			return origin
		}
	}
	for _, issue := range snapshot.Issues {
		if issue.Forge != forge {
			continue
		}
		if origin := dashboard.WebOrigin(issue.URL); origin != "" {
			return origin
		}
	}

	return ""
}

// linkCommenters gives each comment's author a profile page. It copies the
// person rather than writing through the pointer, which a source may share.
func linkCommenters(comments []dashboard.DetailsComment, forge dashboard.Forge, origin string) {
	for i := range comments {
		author := comments[i].Author
		if author == nil {
			continue
		}
		linked := *author
		linked.URL = dashboard.ProfileURL(forge, origin, linked.Login)
		comments[i].Author = &linked
	}
}
