package dashboard

import (
	"slices"
)

// StackPosition is where a pull request sits in a stack of pull requests
// (#860). Matches components.schemas.StackPosition.
type StackPosition struct {
	// Position is 1 for the bottom of the stack, 2 for a pull request
	// stacked directly on it, and so on.
	Position int `json:"position"`
	// Size is how many open pull requests the stack holds.
	Size int `json:"size"`
}

// StackRef names the pull request another is stacked on. Matches
// components.schemas.StackRef.
type StackRef struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
}

// AnnotateStacks fills Stack, StackedOn and StackChildren on every pull
// request in prs, replacing whatever was there (#860). Pull request B is
// stacked on A when B's base branch is A's head branch, in the same
// repository on the same forge, and neither is a fork. A branch with several
// open pull requests takes the lowest-numbered one as parent, and a loop of
// branches is treated as no stack at all. prs holds open pull requests only,
// so a base branch no open pull request owns is not flagged.
func AnnotateStacks(prs []PullRequest) {
	for i := range prs {
		prs[i].Stack = nil
		prs[i].StackedOn = nil
		prs[i].StackChildren = []int{}
	}

	parent := parents(prs)
	dropCycles(parent)

	children := make([][]int, len(prs))
	for child, p := range parent {
		if p >= 0 {
			children[p] = append(children[p], child)
		}
	}

	root := make([]int, len(prs))
	depth := make([]int, len(prs))
	size := make([]int, len(prs))
	for i := range prs {
		r := i
		for parent[r] >= 0 {
			r = parent[r]
			depth[i]++
		}
		root[i] = r
		size[r]++
	}

	for i := range prs {
		if p := parent[i]; p >= 0 {
			prs[i].StackedOn = &StackRef{Number: prs[p].Number, URL: prs[p].URL}
		}
		for _, c := range children[i] {
			prs[i].StackChildren = append(prs[i].StackChildren, prs[c].Number)
		}
		slices.Sort(prs[i].StackChildren)
		if parent[i] >= 0 || len(children[i]) > 0 {
			prs[i].Stack = &StackPosition{Position: depth[i] + 1, Size: size[root[i]]}
		}
	}
}

// parents returns, for each pull request, the index of the one it is stacked
// on, or -1.
func parents(prs []PullRequest) []int {
	type repoKey struct {
		forge Forge
		repo  string
	}
	type branchKey struct {
		repo   repoKey
		branch string
	}

	// owner maps a head branch to the lowest-numbered open, non-fork pull
	// request that comes from it.
	owner := map[branchKey]int{}
	for i, pr := range prs {
		if pr.CrossRepository || pr.HeadBranch == "" {
			continue
		}
		key := branchKey{repoKey{pr.Forge, pr.Repo}, pr.HeadBranch}
		if current, ok := owner[key]; !ok || pr.Number < prs[current].Number {
			owner[key] = i
		}
	}

	parent := make([]int, len(prs))
	for i, pr := range prs {
		parent[i] = -1
		if pr.CrossRepository || pr.BaseBranch == "" {
			continue
		}
		if p, ok := owner[branchKey{repoKey{pr.Forge, pr.Repo}, pr.BaseBranch}]; ok && p != i {
			parent[i] = p
		}
	}

	return parent
}

// dropCycles unlinks every pull request whose chain of parents runs into a
// loop, or ends in one, so a loop of branches yields no stack at all.
func dropCycles(parent []int) {
	bad := map[int]bool{}
	for start := range parent {
		seen := map[int]bool{}
		walked := []int{}
		for at := start; at >= 0; at = parent[at] {
			if seen[at] {
				for _, n := range walked {
					bad[n] = true
				}

				break
			}
			seen[at] = true
			walked = append(walked, at)
		}
	}
	for i := range parent {
		if bad[i] || (parent[i] >= 0 && bad[parent[i]]) {
			parent[i] = -1
		}
	}
}
