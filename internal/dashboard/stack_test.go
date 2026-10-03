package dashboard_test

import (
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func stackPR(number int, base, head string, mutate ...func(*dashboard.PullRequest)) dashboard.PullRequest {
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: number,
		URL:        "https://github.com/o/r/pull/" + strconv.Itoa(number),
		BaseBranch: base, HeadBranch: head,
	}
	for _, m := range mutate {
		m(&pr)
	}

	return pr
}

func byNumber(prs []dashboard.PullRequest) map[int]dashboard.PullRequest {
	out := map[int]dashboard.PullRequest{}
	for _, pr := range prs {
		out[pr.Number] = pr
	}

	return out
}

// A stack is pull requests where each one's base branch is the previous one's
// head branch (#860), worked out from branch names within one repository.
func TestAnnotateStacks(t *testing.T) {
	t.Parallel()

	t.Run("a chain of three gets positions, parents and children", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{
			stackPR(3, "feat/b", "feat/c"),
			stackPR(1, "main", "feat/a"),
			stackPR(2, "feat/a", "feat/b"),
		}

		dashboard.AnnotateStacks(prs)
		got := byNumber(prs)

		assert.Equal(t, &dashboard.StackPosition{Position: 1, Size: 3}, got[1].Stack)
		assert.Equal(t, &dashboard.StackPosition{Position: 2, Size: 3}, got[2].Stack)
		assert.Equal(t, &dashboard.StackPosition{Position: 3, Size: 3}, got[3].Stack)
		assert.Nil(t, got[1].StackedOn)
		require.NotNil(t, got[2].StackedOn)
		assert.Equal(t, 1, got[2].StackedOn.Number)
		require.NotNil(t, got[3].StackedOn)
		assert.Equal(t, 2, got[3].StackedOn.Number)
		assert.Equal(t, []int{2}, got[1].StackChildren)
		assert.Equal(t, []int{3}, got[2].StackChildren)
		assert.Equal(t, []int{}, got[3].StackChildren, "always a list, never null")
	})

	t.Run("a pull request in no stack has none", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{stackPR(1, "main", "feat/a"), stackPR(2, "main", "feat/b")}

		dashboard.AnnotateStacks(prs)

		for _, pr := range prs {
			assert.Nil(t, pr.Stack)
			assert.Nil(t, pr.StackedOn)
			assert.Equal(t, []int{}, pr.StackChildren)
		}
	})

	t.Run("two children of one parent share a stack", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{
			stackPR(1, "main", "feat/a"),
			stackPR(3, "feat/a", "feat/c"),
			stackPR(2, "feat/a", "feat/b"),
		}

		dashboard.AnnotateStacks(prs)
		got := byNumber(prs)

		assert.Equal(t, []int{2, 3}, got[1].StackChildren, "sorted by number")
		assert.Equal(t, &dashboard.StackPosition{Position: 2, Size: 3}, got[2].Stack)
		assert.Equal(t, &dashboard.StackPosition{Position: 2, Size: 3}, got[3].Stack)
	})

	t.Run("a fork is never stacked, nor a parent to a stack", func(t *testing.T) {
		t.Parallel()
		fork := func(p *dashboard.PullRequest) { p.CrossRepository = true }
		prs := []dashboard.PullRequest{
			stackPR(1, "main", "feat/a"),
			stackPR(2, "feat/a", "feat/b", fork),
			stackPR(3, "feat/z", "feat/y", fork),
			stackPR(4, "feat/y", "feat/x"),
		}

		dashboard.AnnotateStacks(prs)
		got := byNumber(prs)

		assert.Nil(t, got[2].Stack)
		assert.Nil(t, got[1].Stack)
		assert.Nil(t, got[4].Stack, "its base is a fork's head branch, which is not this repo's branch")
	})

	t.Run("with several candidate parents the lowest number wins", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{
			stackPR(5, "main", "feat/a"),
			stackPR(2, "main2", "feat/a"),
			stackPR(7, "feat/a", "feat/b"),
		}

		dashboard.AnnotateStacks(prs)
		got := byNumber(prs)

		require.NotNil(t, got[7].StackedOn)
		assert.Equal(t, 2, got[7].StackedOn.Number)
	})

	t.Run("a loop of branches is no stack", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{stackPR(1, "feat/b", "feat/a"), stackPR(2, "feat/a", "feat/b")}

		dashboard.AnnotateStacks(prs)

		for _, pr := range prs {
			assert.Nil(t, pr.Stack)
			assert.Nil(t, pr.StackedOn)
		}
	})

	t.Run("the same branch names in another repo are another stack", func(t *testing.T) {
		t.Parallel()
		other := func(p *dashboard.PullRequest) { p.Repo = "o/other" }
		prs := []dashboard.PullRequest{stackPR(1, "main", "feat/a"), stackPR(2, "feat/a", "feat/b", other)}

		dashboard.AnnotateStacks(prs)

		assert.Nil(t, prs[0].Stack)
		assert.Nil(t, prs[1].Stack)
	})

	t.Run("branch names the forge didn't give never stack", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{stackPR(1, "", ""), stackPR(2, "", "")}

		dashboard.AnnotateStacks(prs)

		assert.Nil(t, prs[0].Stack)
		assert.Nil(t, prs[1].Stack)
	})

	t.Run("re-running it clears a stack that is gone", func(t *testing.T) {
		t.Parallel()
		prs := []dashboard.PullRequest{stackPR(1, "main", "feat/a"), stackPR(2, "feat/a", "feat/b")}
		dashboard.AnnotateStacks(prs)
		require.NotNil(t, prs[1].Stack)

		dashboard.AnnotateStacks(prs[1:])

		assert.Nil(t, prs[1].Stack)
		assert.Nil(t, prs[1].StackedOn)
	})
}
