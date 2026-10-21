package github

import (
	"context"
	"fmt"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pendingChunkSize is how many pull requests one batched query asks about.
// Each carries the same selection a repo query reads, so the node count of a
// chunk stays far under GitHub's 500,000 node limit.
const pendingChunkSize = 25

// RefreshPending implements dashboard.PendingCheckRefresher: it re-reads the
// given pull requests, across any number of repos, in one aliased query per
// pendingChunkSize of them rather than one query per repo. A pull request that
// has merged or closed since it was last read comes back in Closed, and one
// whose branch of the query errored (a repo that is gone, an app that no longer
// reaches it) in Failed, so the caller can fall back for those alone. When a
// later chunk errors, the result holds what the earlier chunks answered along
// with the error, so the calls already spent are not thrown away.
func (c *Client) RefreshPending(ctx context.Context, refs []dashboard.PullRequestRef) (dashboard.PendingResult, error) {
	var result dashboard.PendingResult
	for start := 0; start < len(refs); start += pendingChunkSize {
		chunk := refs[start:min(start+pendingChunkSize, len(refs))]
		if err := c.refreshPendingChunk(ctx, chunk, &result); err != nil {
			return result, err
		}
	}

	return result, nil
}

// pendingAlias is the response key of the i-th pull request in a chunk.
func pendingAlias(i int) string {
	return fmt.Sprintf("pr%d", i)
}

type pendingAnswer struct {
	PullRequest *graphqlPullRequest `json:"pullRequest"`
}

func (c *Client) refreshPendingChunk(ctx context.Context, refs []dashboard.PullRequestRef, result *dashboard.PendingResult) error {
	query, vars := buildPendingQuery(refs)
	var resp map[string]*pendingAnswer
	aliases := make([]string, len(refs))
	for i := range refs {
		aliases[i] = pendingAlias(i)
	}
	failed, err := c.graphqlDoPartial(ctx, query, vars, aliases, &resp)
	if err != nil {
		return err
	}

	var open []repoPullRequest
	for i, ref := range refs {
		alias := aliases[i]
		answer := resp[alias]
		if _, bad := failed[alias]; bad || answer == nil || answer.PullRequest == nil {
			result.Failed = append(result.Failed, ref)

			continue
		}
		if answer.PullRequest.State != "OPEN" {
			result.Closed = append(result.Closed, ref)

			continue
		}
		open = append(open, repoPullRequest{owner: ref.Owner, name: ref.Name, fullName: ref.FullName, node: *answer.PullRequest})
	}
	result.Pulls = append(result.Pulls, c.mapPullRequestsAcross(ctx, open)...)

	return nil
}

// buildPendingQuery asks for each ref's pull request under its own alias.
// Aliased rather than a list argument because the repository differs per
// ref and GraphQL cannot loop server-side. The owner, name and number go in
// as variables, never into the query text.
func buildPendingQuery(refs []dashboard.PullRequestRef) (string, map[string]any) {
	var query strings.Builder
	vars := make(map[string]any, len(refs)*3)

	query.WriteString("query(")
	for i, ref := range refs {
		fmt.Fprintf(&query, "$owner%d: String!, $name%d: String!, $number%d: Int!, ", i, i, i)
		vars[fmt.Sprintf("owner%d", i)] = ref.Owner
		vars[fmt.Sprintf("name%d", i)] = ref.Name
		vars[fmt.Sprintf("number%d", i)] = ref.Number
	}
	query.WriteString(") {\n  rateLimit {\n    cost\n  }\n")
	for i := range refs {
		fmt.Fprintf(&query, "  pr%[1]d: repository(owner: $owner%[1]d, name: $name%[1]d) {\n    pullRequest(number: $number%[1]d) {\n      state\n%[2]s\n    }\n  }\n", i, pullRequestFields)
	}
	query.WriteString("}")

	return query.String(), vars
}
