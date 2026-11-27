package github

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// Member is one GitHub App installation's source: it reads with that
// installation's own token, so it draws on that installation's own rate-limit
// budget (#4586).
type Member struct {
	// ID is GitHub's installation ID.
	ID int64
	// Account is the account or org the App is installed on, when known.
	Account string
	// Source reads what this installation can see.
	Source dashboard.Source
}

// Multi is one GitHub source made of several installations. The aggregator and
// the API find a forge's source by Forge(), so a second GitHub source cannot sit
// beside the first; Multi stands in for all of them and reads each with its own
// token.
//
// Every fetch records which member reported which repo, and Owner answers from
// that, so a call about one repo reaches the installation that can see it.
//
// A repo is read through one installation. An installation sees only its own
// account's repos, so two seldom report the same one; when they do, the first
// member in order keeps it and the later member's rows for it are dropped, so
// nothing is counted twice.
type Multi struct {
	members []Member

	mu    sync.Mutex
	owner map[string]route // lower-cased owner/name
}

// route is the member that reported a repo, and the name as it spelled it.
type route struct {
	member int
	name   string
}

// NewMulti returns the composite for members, in the order they are tried when
// no member has reported a repo yet.
func NewMulti(members []Member) *Multi {
	return &Multi{members: slices.Clone(members), owner: map[string]route{}}
}

// Forge implements dashboard.Source.
func (*Multi) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

// Members returns the installations, in order.
func (m *Multi) Members() []Member { return slices.Clone(m.members) }

// Owner is the member that reported owner/name on a fetch. A repo none has
// reported yet goes to the first member.
func (m *Multi) Owner(owner, name string) Member {
	if len(m.members) == 0 {
		return Member{}
	}

	return m.members[m.ownerIndex(owner, name)]
}

// ownerIndex is Owner's place in the members. A repo none has reported yet is
// the first member's, which is right for reads: they cost nothing if wrong.
func (m *Multi) ownerIndex(owner, name string) int {
	i, _ := m.lookup(owner, name)

	return i
}

// LatestBudgets implements dashboard.BudgetReporter. Each installation has
// budgets of its own: a repo is judged by the one that reads it, and the whole
// account by the tightest. A budget whose window has ended says nothing about
// the account, so it is passed over.
func (m *Multi) LatestBudgets(owner, name string) (graphQL, rest *dashboard.RateLimit) {
	members := m.members
	if owner != "" && len(members) > 0 {
		members = []Member{m.Owner(owner, name)}
	}
	now := time.Now()
	for _, member := range members {
		r, ok := member.Source.(dashboard.BudgetReporter)
		if !ok {
			continue
		}
		g, other := r.LatestBudgets(owner, name)
		graphQL, rest = tighter(graphQL, openWindow(g, now)), tighter(rest, openWindow(other, now))
	}

	return graphQL, rest
}

// openWindow is rl while its window is still open, else nil.
func openWindow(rl *dashboard.RateLimit, now time.Time) *dashboard.RateLimit {
	if rl == nil || !rl.ResetsAt.After(now) {
		return nil
	}

	return rl
}

// lookup is the member that reported owner/name and whether any has.
func (m *Multi) lookup(owner, name string) (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	r, ok := m.owner[strings.ToLower(owner+"/"+name)]

	return r.member, ok
}

// Fetch implements dashboard.Source. It reads every member at once and merges
// the answers. A member that fails is named in the health and keeps its last
// rows; the rest load as usual. Only when every member fails does the forge
// read as unreachable.
func (m *Multi) Fetch(ctx context.Context) dashboard.Result {
	results := make([]dashboard.Result, len(m.members))

	var wg sync.WaitGroup
	for i, member := range m.members {
		wg.Go(func() { results[i] = member.Source.Fetch(ctx) })
	}
	wg.Wait()

	return m.merge(results)
}

func (m *Multi) merge(results []dashboard.Result) dashboard.Result {
	var (
		out     dashboard.Result
		healthy bool
		first   *dashboard.ForgeHealth // the first failed member's health
		failed  []dashboard.FailedInstallation
	)

	m.mu.Lock()
	defer m.mu.Unlock()

	previous := m.owner
	m.owner = make(map[string]route, len(previous))

	for i, r := range results {
		out.Spent = addSpend(out.Spent, r.Spent)
		if !r.Health.Reachable {
			if first == nil {
				first = &results[i].Health
			}
			failed = append(failed, dashboard.FailedInstallation{InstallationID: m.members[i].ID, Account: m.members[i].Account, ErrorKind: r.Health.ErrorKind})

			continue
		}

		r = m.withoutOwned(r)
		if healthy {
			joinHealth(&out.Health, r.Health)
		} else {
			out.Health = r.Health
			healthy = true
		}
		appendRows(&out, r)
		m.learn(i, r.Repos)
	}

	if !healthy {
		// Every member failed (or there is none): the forge did not answer.
		out.Health = dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub}
		if first != nil {
			out.Health = *first
		}
		out.Health.Reachable = false
		m.owner = previous

		return out
	}

	// A failed member says nothing about its repos, so the repos it had last
	// time are named as unchanged and the aggregator keeps their rows. A repo a
	// healthy member reported this time is not one of them.
	for i, r := range results {
		if !r.Health.Reachable {
			out.Unchanged = append(out.Unchanged, m.keepRoutes(previous, i)...)
		}
	}
	slices.Sort(out.Unchanged)

	out.Health.FailedInstallations = failed

	return out
}

// withoutOwned is r without the rows of repos an earlier member already
// reported this fetch.
func (m *Multi) withoutOwned(r dashboard.Result) dashboard.Result {
	taken := map[string]bool{}
	for _, repo := range r.Repos {
		if _, ok := m.owner[strings.ToLower(repo.FullName)]; ok {
			taken[strings.ToLower(repo.FullName)] = true
		}
	}
	if len(taken) == 0 {
		return r
	}

	drop := func(name string) bool { return taken[strings.ToLower(name)] }
	r.Repos = slices.DeleteFunc(slices.Clone(r.Repos), func(x dashboard.Repo) bool { return drop(x.FullName) })
	r.PullRequests = slices.DeleteFunc(slices.Clone(r.PullRequests), func(x dashboard.PullRequest) bool { return drop(x.Repo) })
	r.Issues = slices.DeleteFunc(slices.Clone(r.Issues), func(x dashboard.Issue) bool { return drop(x.Repo) })
	r.MainBranches = slices.DeleteFunc(slices.Clone(r.MainBranches), func(x dashboard.MainBranch) bool { return drop(x.FullName) })
	r.FailedRepos = slices.DeleteFunc(slices.Clone(r.FailedRepos), func(x dashboard.FailedRepo) bool { return drop(x.FullName) })
	r.Unchanged = slices.DeleteFunc(slices.Clone(r.Unchanged), drop)
	r.Health.RepoCount -= len(taken)

	return r
}

// keepRoutes carries member i's earlier routes into the new table and returns
// the repo names they stand for.
func (m *Multi) keepRoutes(previous map[string]route, i int) []string {
	var names []string
	for key, rt := range previous {
		if _, taken := m.owner[key]; rt.member == i && !taken {
			m.owner[key] = rt
			names = append(names, rt.name)
		}
	}

	return names
}

// learn records that member i reported repos. The first member to report a
// repo keeps it.
func (m *Multi) learn(i int, repos []dashboard.Repo) {
	for _, repo := range repos {
		key := strings.ToLower(repo.FullName)
		if _, taken := m.owner[key]; !taken {
			m.owner[key] = route{member: i, name: repo.FullName}
		}
	}
}

// joinHealth folds another member's health into h: repos add up, and each
// budget shows the tighter of the two.
func joinHealth(h *dashboard.ForgeHealth, other dashboard.ForgeHealth) {
	h.RepoCount += other.RepoCount
	h.RateLimitGraphQL = tighter(h.RateLimitGraphQL, other.RateLimitGraphQL)
	h.RateLimitREST = tighter(h.RateLimitREST, other.RateLimitREST)
}

func appendRows(out *dashboard.Result, r dashboard.Result) {
	out.PullRequests = append(out.PullRequests, r.PullRequests...)
	out.Issues = append(out.Issues, r.Issues...)
	out.Repos = append(out.Repos, r.Repos...)
	out.FailedRepos = append(out.FailedRepos, r.FailedRepos...)
	out.MainBranches = append(out.MainBranches, r.MainBranches...)
	out.Unchanged = append(out.Unchanged, r.Unchanged...)
}

func addSpend(a, b *dashboard.Spend) *dashboard.Spend {
	if b == nil {
		return a
	}
	if a == nil {
		c := *b

		return &c
	}

	return &dashboard.Spend{GraphQL: a.GraphQL + b.GraphQL, REST: a.REST + b.REST}
}

// tighter is whichever budget has less left. Each installation has its own, and
// the one closest to running out is the one worth showing. Remaining is compared
// as it is: every installation belongs to the same App, so their limits are
// GitHub's same per-installation allowance, and absolute counts compare.
func tighter(a, b *dashboard.RateLimit) *dashboard.RateLimit {
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case b.Remaining < a.Remaining:
		return b
	default:
		return a
	}
}
