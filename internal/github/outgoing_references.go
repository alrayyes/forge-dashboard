package github

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// outgoingReferences lists what an issue or pull request's own text refers to
// (#4272). GitHub has no field for it, so the text is read the way the board
// reads a pull request's, and the named items are looked up in one more
// request. It is best effort: a lookup that fails leaves the list empty and
// the rest of the dialog as it was.
func (c *Client) outgoingReferences(ctx context.Context, kind dashboard.ItemKind, title, itemURL, body, owner, name string, number int) []dashboard.ItemReference {
	fullName := owner + "/" + name
	base := dashboard.WebBase(itemURL, fullName)
	if base == "" {
		base = "https://github.com"
	}

	return dashboard.OutgoingReferences(ctx, dashboard.ForgeGitHub, kind, title, body, fullName, number, base, c.lookUpTargets)
}

// lookUpTargets asks for every target under its own alias, as
// buildPendingQuery does, since the repository differs per target. A target
// GitHub can't resolve (a deleted item, a repo the token can't see) comes back
// null and is left out.
func (c *Client) lookUpTargets(ctx context.Context, targets []dashboard.OutgoingTarget) []dashboard.ItemReference {
	query, vars, aliases := buildTargetQuery(targets)
	var resp map[string]*struct {
		Item *struct {
			Typename   string `json:"__typename"`
			Number     int    `json:"number"`
			Title      string `json:"title"`
			URL        string `json:"url"`
			State      string `json:"state"`
			Repository struct {
				NameWithOwner string `json:"nameWithOwner"`
			} `json:"repository"`
		} `json:"issueOrPullRequest"`
	}
	failed, err := c.graphqlDoPartial(ctx, query, vars, aliases, &resp)
	if err != nil {
		slog.Warn("github outgoing references lookup failed", "error", err)

		return nil
	}

	var refs []dashboard.ItemReference
	for i, alias := range aliases {
		answer := resp[alias]
		if _, bad := failed[alias]; bad || answer == nil || answer.Item == nil || answer.Item.Number == 0 {
			continue
		}
		item := answer.Item
		repo := item.Repository.NameWithOwner
		if repo == "" {
			repo = targets[i].Repo
		}
		ref := dashboard.ItemReference{
			Forge: dashboard.ForgeGitHub, Repo: repo, Number: item.Number, Title: item.Title, URL: item.URL,
			Kind: dashboard.ItemKindIssue, State: pullRequestStateOf(item.State),
		}
		if item.Typename == "PullRequest" {
			ref.Kind = dashboard.ItemKindPullRequest
		}
		refs = append(refs, ref)
	}

	return refs
}

// buildTargetQuery is the lookup of targets and the aliases it answers under.
// Owner, name and number go in as variables, never into the query text.
func buildTargetQuery(targets []dashboard.OutgoingTarget) (string, map[string]any, []string) {
	var query strings.Builder
	vars := make(map[string]any, len(targets)*3)
	aliases := make([]string, len(targets))

	query.WriteString("query(")
	for i, target := range targets {
		owner, name, _ := strings.Cut(target.Repo, "/")
		fmt.Fprintf(&query, "$owner%d: String!, $name%d: String!, $number%d: Int!, ", i, i, i)
		vars[fmt.Sprintf("owner%d", i)] = owner
		vars[fmt.Sprintf("name%d", i)] = name
		vars[fmt.Sprintf("number%d", i)] = target.Number
		aliases[i] = fmt.Sprintf("t%d", i)
	}
	query.WriteString(") {\n  rateLimit {\n    cost\n  }\n")
	for i := range targets {
		fmt.Fprintf(&query, `  t%[1]d: repository(owner: $owner%[1]d, name: $name%[1]d) {
    issueOrPullRequest(number: $number%[1]d) {
      __typename
      ... on Issue { number title url state repository { nameWithOwner } }
      ... on PullRequest { number title url state repository { nameWithOwner } }
    }
  }
`, i)
	}
	query.WriteString("}")

	return query.String(), vars, aliases
}
