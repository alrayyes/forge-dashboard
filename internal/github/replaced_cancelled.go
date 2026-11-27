package github

import (
	"cmp"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sync"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// A pull request's rollup keeps a cancelled check run after a later run of the
// same job has replaced it, as a concurrency group does when two events start a
// workflow seconds apart (#5116). The pull request query asks for counts only,
// which can't say which run was replaced, so the checks of such a head are read
// by their commit's id.

// headChecksQuery reads the checks of the given commits.
const headChecksQuery = `query($ids: [ID!]!) {
  rateLimit { cost }
  nodes(ids: $ids) {
    ... on Commit {
      id
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun {
              name
              status
              conclusion
              checkSuite {
                workflowRun {
                  databaseId
                  runAttempt
                  runNumber
                  event
                  workflow { databaseId name }
                }
              }
            }
          }
        }
      }
    }
  }
}`

// replacedRunsMax bounds the cache. Reaching it empties it, which costs one
// more read per head that still needs one.
const replacedRunsMax = 2000

// ReplacedRunsCache remembers how many cancelled runs of a head commit a later
// run replaced, for as long as the commit's check counts stay the same.
type ReplacedRunsCache struct {
	mu      sync.Mutex
	entries map[string]replacedRuns
}

type replacedRuns struct {
	counts   string
	replaced int
}

// NewReplacedRunsCache returns an empty cache.
func NewReplacedRunsCache() *ReplacedRunsCache {
	return &ReplacedRunsCache{entries: map[string]replacedRuns{}}
}

func (c *ReplacedRunsCache) get(id, counts string) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[id]

	return e.replaced, ok && e.counts == counts
}

func (c *ReplacedRunsCache) put(id, counts string, replaced int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= replacedRunsMax {
		clear(c.entries)
	}
	c.entries[id] = replacedRuns{counts: counts, replaced: replaced}
}

// ShareReplacedRunsCache makes this Client use cache. A source builder makes a
// fresh Client per settings load, so a head is read once across them.
func (c *Client) ShareReplacedRunsCache(cache *ReplacedRunsCache) { c.replacedRuns = cache }

// headRollup is a pull request head's rollup that may hold a replaced run.
type headRollup struct {
	id, counts string
	rollup     *statusCheckRollup
}

// replaceable reports the head rollup of p, when it counts a cancelled run
// beside another run that could have replaced it.
func replaceable(p graphqlPullRequest) (headRollup, bool) {
	if len(p.Commits.Nodes) == 0 || rollupIsOfAnotherCommit(p.Commits.Nodes, p.HeadRefOid) {
		return headRollup{}, false
	}
	commit := p.Commits.Nodes[0].Commit
	r := commit.StatusCheckRollup
	if commit.ID == "" || r == nil || r.Contexts == nil {
		return headRollup{}, false
	}
	runs := 0
	for _, c := range r.Contexts.CheckRunCountsByState {
		runs += c.Count
	}
	cancelled := r.runsInState("CANCELLED")
	if cancelled == 0 || runs == cancelled {
		return headRollup{}, false
	}

	counts := slices.Clone(r.Contexts.CheckRunCountsByState)
	slices.SortFunc(counts, func(a, b stateCount) int { return cmp.Compare(a.State, b.State) })

	return headRollup{id: commit.ID, counts: fmt.Sprint(counts), rollup: r}, true
}

// dropReplacedCancelled takes the cancelled runs a later run replaced out of
// each pull request's head rollup, before anything reads it. Only a head with a
// cancelled run beside others is looked up, up to suiteChunkSize commits to a
// query, and only again once its counts change. A failed read leaves the rollup
// as GitHub gave it.
func (c *Client) dropReplacedCancelled(ctx context.Context, prs []graphqlPullRequest) {
	var unread []headRollup
	var ids []string
	for _, p := range prs {
		head, ok := replaceable(p)
		if !ok {
			continue
		}
		if n, ok := c.replacedRuns.get(head.id, head.counts); ok {
			head.rollup.dropCancelled(n)

			continue
		}
		unread = append(unread, head)
		if !slices.Contains(ids, head.id) {
			ids = append(ids, head.id)
		}
	}
	if len(ids) == 0 {
		return
	}

	read := c.readReplacedCancelled(ctx, ids)
	for _, head := range unread {
		if n, ok := read[head.id]; ok {
			c.replacedRuns.put(head.id, head.counts, n)
			head.rollup.dropCancelled(n)
		}
	}
}

// readReplacedCancelled is how many cancelled runs of each commit a later run
// replaced, among its first 100 checks. A failed read is logged and leaves its
// commits out.
func (c *Client) readReplacedCancelled(ctx context.Context, ids []string) map[string]int {
	out := make(map[string]int, len(ids))
	for chunk := range slices.Chunk(ids, suiteChunkSize) {
		var resp struct {
			Nodes []struct {
				ID                string             `json:"id"`
				StatusCheckRollup *statusCheckRollup `json:"statusCheckRollup"`
			} `json:"nodes"`
		}
		if err := c.graphqlDo(ctx, headChecksQuery, map[string]any{"ids": chunk}, &resp); err != nil {
			slog.Warn("github replaced-run lookup failed", "forge", dashboard.ForgeGitHub, "error", err)

			continue
		}
		for _, n := range resp.Nodes {
			if n.StatusCheckRollup == nil || n.StatusCheckRollup.Contexts == nil {
				continue
			}
			checks := make([]dashboard.Check, len(n.StatusCheckRollup.Contexts.Nodes))
			for i, node := range n.StatusCheckRollup.Contexts.Nodes {
				checks[i] = node.asCheck()
			}
			out[n.ID] = len(checks) - len(dashboard.WithoutReplacedCancelled(checks))
		}
	}

	return out
}

// dropCancelled takes n replaced runs off the cancelled count. A state that
// only they kept failing then reads from what is left.
func (r *statusCheckRollup) dropCancelled(n int) {
	if n == 0 {
		return
	}
	counts := slices.Clone(r.Contexts.CheckRunCountsByState)
	for i := range counts {
		if counts[i].State == "CANCELLED" {
			counts[i].Count = max(counts[i].Count-n, 0)
		}
	}
	r.Contexts.CheckRunCountsByState = counts

	failing := r.State == "FAILURE" || r.State == "ERROR"
	if !failing || r.runsInState("CANCELLED") > 0 || r.hasFailedContext(failureKinds{heldRun: true}) {
		return
	}
	// A check nobody can grade is not a pass.
	if left := r.rawCheckCounts(); left.Running+left.Waiting+left.Unknown > 0 {
		r.State = "PENDING"
	} else {
		r.State = "SUCCESS"
	}
}

// withoutReplacedRuns is runs without the cancelled ones a later run replaced,
// for the tokenless REST fallback. A check run doesn't name its workflow, so
// the head's workflow runs are read, and only when a cancelled run sits beside
// another.
func (c *Client) withoutReplacedRuns(ctx context.Context, owner, name, sha string, runs []*ghsdk.CheckRun) []*ghsdk.CheckRun {
	cancelled := func(r *ghsdk.CheckRun) bool { return checkStateFromRun(r) == dashboard.CheckCancelled }
	if !slices.ContainsFunc(runs, cancelled) || !slices.ContainsFunc(runs, func(r *ghsdk.CheckRun) bool { return !cancelled(r) }) {
		return runs
	}

	checks := make([]dashboard.Check, len(runs))
	for i, r := range runs {
		checks[i] = dashboard.Check{
			Name: r.GetName(), State: checkStateFromRun(r), URL: r.GetHTMLURL(), JobID: r.GetID(),
			ReportedConclusion: reportedConclusion(r),
		}
	}
	c.attachRuns(ctx, owner, name, sha, checks)

	kept := map[int64]bool{}
	for _, check := range dashboard.WithoutReplacedCancelled(checks) {
		kept[check.JobID] = true
	}

	return slices.DeleteFunc(slices.Clone(runs), func(r *ghsdk.CheckRun) bool { return !kept[r.GetID()] })
}
