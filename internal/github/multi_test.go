package github_test

import (
	"context"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeInstallation is one installation's source: it answers Fetch with res.
type fakeInstallation struct{ res dashboard.Result }

func (f fakeInstallation) Fetch(context.Context) dashboard.Result { return f.res }
func (fakeInstallation) Forge() dashboard.Forge                   { return dashboard.ForgeGitHub }

func answered(repo string, remaining int) dashboard.Result {
	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1, RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: remaining, ResetsAt: time.Unix(100, 0)}},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: repo, Number: 1}},
		Issues:       []dashboard.Issue{{Forge: dashboard.ForgeGitHub, Repo: repo, Number: 2}},
		Repos:        []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: repo}},
		MainBranches: []dashboard.MainBranch{{Forge: dashboard.ForgeGitHub, FullName: repo}},
		Spent:        &dashboard.Spend{GraphQL: 3, REST: 2},
	}
}

func failed(kind dashboard.ForgeErrorKind) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Error: dashboard.HumanizeForgeError(kind), ErrorKind: kind}}
}

func multiOf(members ...github.Member) *github.Multi { return github.NewMulti(members) }

func TestMulti_ForgeIsGitHub(t *testing.T) {
	assert.Equal(t, dashboard.ForgeGitHub, multiOf().Forge())
}

func TestMulti_FetchMergesEveryInstallation(t *testing.T) {
	m := multiOf(
		github.Member{ID: 1, Account: "alice", Source: fakeInstallation{answered("alice/a", 4000)}},
		github.Member{ID: 2, Account: "acme", Source: fakeInstallation{answered("acme/b", 100)}},
	)

	res := m.Fetch(t.Context())

	assert.True(t, res.Health.Reachable)
	assert.Empty(t, res.Health.FailedInstallations)
	assert.Equal(t, 2, res.Health.RepoCount)
	assert.Len(t, res.PullRequests, 2)
	assert.Len(t, res.Issues, 2)
	assert.Len(t, res.Repos, 2)
	assert.Len(t, res.MainBranches, 2)
	assert.Equal(t, &dashboard.Spend{GraphQL: 6, REST: 4}, res.Spent)
	// The budget closest to running out is the one worth showing.
	require.NotNil(t, res.Health.RateLimitGraphQL)
	assert.Equal(t, 100, res.Health.RateLimitGraphQL.Remaining)
}

func TestMulti_OneFailureStillLoadsTheOthersAndNamesIt(t *testing.T) {
	m := multiOf(
		github.Member{ID: 1, Account: "alice", Source: fakeInstallation{answered("alice/a", 4000)}},
		github.Member{ID: 2, Account: "acme", Source: fakeInstallation{failed(dashboard.ForgeErrorUnauthorized)}},
	)

	res := m.Fetch(t.Context())

	assert.True(t, res.Health.Reachable)
	assert.Empty(t, res.Health.Error)
	assert.Len(t, res.PullRequests, 1)
	assert.Equal(t, []dashboard.FailedInstallation{{InstallationID: 2, Account: "acme", ErrorKind: dashboard.ForgeErrorUnauthorized}}, res.Health.FailedInstallations)
}

func TestMulti_FailedInstallationKeepsItsLastRows(t *testing.T) {
	good := fakeInstallation{answered("acme/b", 100)}
	m := multiOf(
		github.Member{ID: 1, Account: "alice", Source: fakeInstallation{answered("alice/a", 4000)}},
		github.Member{ID: 2, Account: "acme", Source: &swapSource{res: good.res}},
	)
	m.Fetch(t.Context()) // teaches the composite that acme/b is installation 2's
	m.Members()[1].Source.(*swapSource).res = failed(dashboard.ForgeErrorUnreachable)

	res := m.Fetch(t.Context())

	assert.Equal(t, []string{"acme/b"}, res.Unchanged)
}

func TestMulti_EveryInstallationFailingIsUnreachable(t *testing.T) {
	m := multiOf(
		github.Member{ID: 1, Source: fakeInstallation{failed(dashboard.ForgeErrorUnreachable)}},
		github.Member{ID: 2, Source: fakeInstallation{failed(dashboard.ForgeErrorUnauthorized)}},
	)

	res := m.Fetch(t.Context())

	assert.False(t, res.Health.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, res.Health.ErrorKind)
	assert.Empty(t, res.Health.FailedInstallations)
}

func TestMulti_RoutesARepoToTheInstallationThatReportedIt(t *testing.T) {
	m := multiOf(
		github.Member{ID: 1, Source: fakeInstallation{answered("alice/a", 4000)}},
		github.Member{ID: 2, Source: fakeInstallation{answered("acme/b", 100)}},
	)

	// Before any fetch nobody owns the repo, so the first member answers.
	assert.Equal(t, int64(1), m.Owner("acme", "b").ID)

	m.Fetch(t.Context())

	assert.Equal(t, int64(2), m.Owner("acme", "b").ID)
	assert.Equal(t, int64(1), m.Owner("alice", "a").ID)
	assert.Equal(t, int64(1), m.Owner("nobody", "x").ID)
}

type swapSource struct{ res dashboard.Result }

func (s *swapSource) Fetch(context.Context) dashboard.Result { return s.res }
func (*swapSource) Forge() dashboard.Forge                   { return dashboard.ForgeGitHub }

func TestMulti_UnchangedIsSorted(t *testing.T) {
	src := &swapSource{res: dashboard.Result{
		Health: dashboard.ForgeHealth{Reachable: true},
		Repos:  []dashboard.Repo{{FullName: "acme/c"}, {FullName: "acme/a"}, {FullName: "acme/b"}},
	}}
	m := multiOf(
		github.Member{ID: 1, Source: fakeInstallation{answered("alice/a", 1)}},
		github.Member{ID: 2, Source: src},
	)
	m.Fetch(t.Context())
	src.res = failed(dashboard.ForgeErrorUnreachable)

	for range 20 {
		assert.Equal(t, []string{"acme/a", "acme/b", "acme/c"}, m.Fetch(t.Context()).Unchanged)
	}
}

func TestMulti_AllFailedKeepsTheEarlierRoutesAndReportsNothingUnchanged(t *testing.T) {
	a := &swapSource{res: answered("alice/a", 1)}
	b := &swapSource{res: answered("acme/b", 100)}
	m := multiOf(github.Member{ID: 1, Source: a}, github.Member{ID: 2, Source: b})
	m.Fetch(t.Context())
	a.res = failed(dashboard.ForgeErrorUnreachable)
	b.res = failed(dashboard.ForgeErrorUnreachable)

	res := m.Fetch(t.Context())

	assert.False(t, res.Health.Reachable)
	assert.Empty(t, res.Unchanged)
	assert.Empty(t, res.Health.FailedInstallations)
	assert.Equal(t, int64(2), m.Owner("acme", "b").ID, "the routes learned before survive")
	assert.Equal(t, int64(1), m.Owner("alice", "a").ID)
}

func TestMulti_RESTBudgetShowsTheTighterAndToleratesNil(t *testing.T) {
	rest := func(remaining int) dashboard.Result {
		r := answered("x/"+string(rune('a'+remaining%26)), 1)
		if remaining >= 0 {
			r.Health.RateLimitREST = &dashboard.RateLimit{Limit: 5000, Remaining: remaining}
		}
		r.Health.RateLimitGraphQL = nil

		return r
	}
	m := multiOf(
		github.Member{ID: 1, Source: fakeInstallation{rest(-1)}},
		github.Member{ID: 2, Source: fakeInstallation{rest(300)}},
		github.Member{ID: 3, Source: fakeInstallation{rest(900)}},
		github.Member{ID: 4, Source: fakeInstallation{rest(-1)}},
	)

	res := m.Fetch(t.Context())

	require.NotNil(t, res.Health.RateLimitREST)
	assert.Equal(t, 300, res.Health.RateLimitREST.Remaining)
	assert.Nil(t, res.Health.RateLimitGraphQL)
}

func TestMulti_ARepoTwoInstallationsSeeIsReadOnceFromTheFirst(t *testing.T) {
	first := answered("acme/shared", 100)
	first.PullRequests[0].Title = "first"
	second := answered("acme/shared", 100)
	second.PullRequests[0].Title = "second"
	m := multiOf(
		github.Member{ID: 1, Source: fakeInstallation{first}},
		github.Member{ID: 2, Source: fakeInstallation{second}},
	)

	res := m.Fetch(t.Context())

	require.Len(t, res.PullRequests, 1)
	assert.Equal(t, "first", res.PullRequests[0].Title)
	assert.Len(t, res.Issues, 1)
	assert.Len(t, res.Repos, 1)
	assert.Len(t, res.MainBranches, 1)
	assert.Equal(t, 1, res.Health.RepoCount)
	assert.Equal(t, int64(1), m.Owner("acme", "shared").ID)
}

func TestMulti_AFailedInstallationDoesNotKeepARepoAHealthyOneReported(t *testing.T) {
	failing := &swapSource{res: answered("acme/shared", 100)}
	m := multiOf(
		github.Member{ID: 1, Source: failing},
		github.Member{ID: 2, Source: fakeInstallation{answered("acme/shared", 100)}},
	)
	m.Fetch(t.Context())
	failing.res = failed(dashboard.ForgeErrorUnreachable)

	res := m.Fetch(t.Context())

	assert.Empty(t, res.Unchanged)
	assert.Len(t, res.PullRequests, 1)
	assert.Equal(t, int64(2), m.Owner("acme", "shared").ID)
}

func TestMulti_OwnerWithNoMembersDoesNotPanic(t *testing.T) {
	m := multiOf()

	assert.Equal(t, github.Member{}, m.Owner("a", "b"))
	assert.Equal(t, dashboard.ForgeGitHub, m.Fetch(t.Context()).Health.Forge)
	assert.False(t, m.Fetch(t.Context()).Health.Reachable)
}

func TestMulti_MembersIsACopy(t *testing.T) {
	m := multiOf(github.Member{ID: 1, Source: fakeInstallation{}}, github.Member{ID: 2, Source: fakeInstallation{}})

	got := m.Members()
	got[0], got[1] = got[1], got[0]

	assert.Equal(t, int64(1), m.Members()[0].ID)
}

func TestMulti_OwnerIsSafeWhileFetchRuns(t *testing.T) {
	m := multiOf(
		github.Member{ID: 1, Source: fakeInstallation{answered("alice/a", 1)}},
		github.Member{ID: 2, Source: fakeInstallation{answered("acme/b", 1)}},
	)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 200 {
			m.Fetch(context.Background())
		}
	}()
	for range 2000 {
		assert.Contains(t, []int64{1, 2}, m.Owner("acme", "b").ID)
	}
	<-done
}
