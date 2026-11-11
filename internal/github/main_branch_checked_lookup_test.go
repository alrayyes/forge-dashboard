package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// maxRequestNodes is the most nodes one request of the checked-commit lookup
// may be able to return (#3530). GitHub times a request out well before its
// 500,000 node limit: the single request that read 10 commits of every repo
// with 150 checks each answered 504 (#3527), and by this count it could return
// about 147,000 nodes for 25 repos. Raise this only knowing what it costs.
const maxRequestNodes = 10_000

// maxLookupAliases is the most repos one request of the lookup names.
const maxLookupAliases = 25

var (
	fieldArgs     = regexp.MustCompile(`(?:first|last):\s*(\d+)`)
	aliasedFields = regexp.MustCompile(`(?m)^\s*([mc]\d+):`)
)

// nodeBudget counts the nodes a GraphQL query can return, the way GitHub's
// resource limits describe them: each selection set under a field costs the
// product of the page sizes (first/last) on the way down to it. `nodes` wrappers
// and inline fragments add nothing; the root and rateLimit are free.
func nodeBudget(query string) int {
	total := 0
	mult := []int{1}
	start := 0
	for i, ch := range query {
		switch ch {
		case '{':
			header := strings.TrimSpace(query[start:i])
			parent := mult[len(mult)-1]
			size := 1
			if m := fieldArgs.FindStringSubmatch(lastField(header)); m != nil {
				size, _ = strconv.Atoi(m[1])
			}
			cur := parent * size
			name := fieldName(header)
			if name != "nodes" && name != "rateLimit" && !strings.HasPrefix(header, "...") && !strings.HasPrefix(header, "query") && !strings.HasSuffix(header, "...") {
				total += cur
			}
			mult = append(mult, cur)
			start = i + 1
		case '}':
			mult = mult[:len(mult)-1]
			start = i + 1
		case '\n':
			start = i + 1
		}
	}

	return total
}

// lastField is the last field of a header, with its arguments.
func lastField(header string) string {
	if strings.HasSuffix(header, ")") {
		if open := strings.LastIndex(header, "("); open >= 0 {
			return header[open:]
		}
	}
	fields := strings.Fields(header)
	if len(fields) == 0 {
		return ""
	}

	return fields[len(fields)-1]
}

func fieldName(header string) string {
	f := lastField(header)
	if strings.HasPrefix(f, "(") {
		before := strings.TrimSpace(header[:len(header)-len(f)])
		fields := strings.Fields(before)
		if len(fields) == 0 {
			return ""
		}
		f = fields[len(fields)-1]
	}

	return strings.TrimSuffix(strings.TrimSuffix(f, ":"), "{")
}

// lookupRecorder is the fake GitHub for the checked-commit lookup: a viewer
// whose repos all have a "[skip ci]" newest commit, a light history answer and
// a per-commit answer, and a log of every request the lookup made.
type lookupRecorder struct {
	mu       sync.Mutex
	history  []string // queries that read history
	commits  []string // queries that read single commits by oid
	commitBy func(repo int) []map[string]any
}

func commitOf(oid, headline string, rollup map[string]any) map[string]any {
	commit := map[string]any{
		"oid": oid, "abbreviatedOid": oid[:7], "messageHeadline": headline,
		"url":           "https://github.com/alrayyes/a/commit/" + oid[:7],
		"committedDate": "2026-10-09T09:00:00Z", "statusCheckRollup": nil,
	}
	if rollup != nil {
		commit["statusCheckRollup"] = rollup
	}

	return commit
}

func repoIndex(name string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(name, "r"))

	return n
}

// lookupAnswer adds to data what GitHub answers a checked-commit lookup request
// with, for the history (light) and the single-commit (full) shapes, and says
// whether req was one. commitsOf lists a repo's history, newest first.
func lookupAnswer(req graphqlRequestBody, data map[string]any, commitsOf func(repo string) []map[string]any) bool {
	history := strings.Contains(req.Query, "history(")
	if !history && !strings.Contains(req.Query, "object(oid") {
		return false
	}
	for _, m := range aliasedFields.FindAllStringSubmatch(req.Query, -1) {
		i := m[1][1:]
		commits := commitsOf(fmt.Sprint(req.Variables["name"+i]))
		if history {
			data[m[1]] = lightHistory(commits)
		} else {
			data[m[1]] = map[string]any{"object": commitByOID(commits, req.Variables["oid"+i])}
		}
	}

	return true
}

// commitByOID is the commit with the oid, nil for none.
func commitByOID(commits []map[string]any, oid any) any {
	for _, c := range commits {
		if c["oid"] == oid {
			return c
		}
	}

	return nil
}

// lightHistory is a repo's history the way the first request reads it: the oid
// of each commit and whether it has a rollup.
func lightHistory(commits []map[string]any) map[string]any {
	nodes := []map[string]any{}
	for _, c := range commits {
		light := map[string]any{"oid": c["oid"], "statusCheckRollup": nil}
		if c["statusCheckRollup"] != nil {
			light["statusCheckRollup"] = map[string]any{"state": "SUCCESS"}
		}
		nodes = append(nodes, light)
	}

	return map[string]any{"defaultBranchRef": map[string]any{"target": map[string]any{
		"history": map[string]any{"nodes": nodes},
	}}}
}

// serve answers the viewer query and the lookup. historyOf lists the commits
// (newest first) a repo's history holds.
func (l *lookupRecorder) serve(t *testing.T, repos int) *httptest.Server {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		req := readGraphQLRequest(t, r)
		rate := map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"}
		data := map[string]any{"rateLimit": rate}
		switch {
		case lookupAnswer(req, data, func(repo string) []map[string]any { return l.commitBy(repoIndex(repo)) }):
			l.mu.Lock()
			if strings.Contains(req.Query, "history(") {
				l.history = append(l.history, req.Query)
			} else {
				l.commits = append(l.commits, req.Query)
			}
			l.mu.Unlock()
		default:
			nodes := []map[string]any{}
			for i := range repos {
				head := branchRef(nil)
				head["target"] = commitOf(fmt.Sprintf("%040d", 1), "chore(release): 1.0.0 [skip ci]", nil)
				nodes = append(nodes, map[string]any{
					"name": fmt.Sprintf("r%d", i), "url": fmt.Sprintf("https://github.com/alrayyes/r%d", i),
					"viewerPermission": "WRITE", "owner": map[string]any{"login": "alrayyes"},
					"pullRequests":     map[string]any{"nodes": []map[string]any{}},
					"issues":           map[string]any{"nodes": []map[string]any{}},
					"defaultBranchRef": head,
				})
			}
			data["viewer"] = map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false}, "nodes": nodes,
			}}
		}
		writeJSON(t, w, map[string]any{"data": data})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func passingRollup() map[string]any {
	return rollupOf("SUCCESS", map[string]int{"SUCCESS": 1},
		checkRun("ci", "SUCCESS", "2026-10-09T09:01:00Z", "2026-10-09T09:03:00Z"))
}

func dependabotRollup() map[string]any {
	update := workflowRun(2, 1, 6, "Dependabot Updates")
	update["event"] = "dynamic"

	return rollupOf("FAILURE", map[string]int{"FAILURE": 1},
		runCheck(21, "Dependabot", "COMPLETED", "FAILURE", "2026-10-09T09:01:00Z", "2026-10-09T09:03:00Z", runsURL+"2/job/21", suiteOf("COMPLETED", "FAILURE", update)))
}

// The first request of the lookup reads only whether each commit has checks.
// Nothing in it selects a check suite or a check (#3530).
func TestFetch_MainBranch_TheCheckedCommitLookupFirstReadsOnlyEachCommitsRollupState(t *testing.T) {
	t.Parallel()

	rec := &lookupRecorder{commitBy: func(int) []map[string]any {
		return []map[string]any{
			commitOf(fmt.Sprintf("%040d", 1), "chore: [skip ci]", nil),
			commitOf(fmt.Sprintf("%040d", 2), "fix: a thing", passingRollup()),
		}
	}}
	srv := rec.serve(t, 1)

	github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, rec.history, 1)
	assert.NotContains(t, rec.history[0], "checkSuites")
	assert.NotContains(t, rec.history[0], "contexts")
	assert.Contains(t, rec.history[0], "statusCheckRollup { state }")
}

// The full checks are read for the one commit the row shows, not for each of
// the ten the walk looks at.
func TestFetch_MainBranch_TheCheckedCommitLookupReadsFullChecksOnlyForTheCommitItPicks(t *testing.T) {
	t.Parallel()

	rec := &lookupRecorder{commitBy: func(int) []map[string]any {
		return []map[string]any{
			commitOf(fmt.Sprintf("%040d", 1), "chore: [skip ci]", nil),
			commitOf(fmt.Sprintf("%040d", 2), "fix: a thing", passingRollup()),
			commitOf(fmt.Sprintf("%040d", 3), "fix: an older thing", passingRollup()),
		}
	}}
	srv := rec.serve(t, 1)

	github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, rec.commits, 1, "one read for the one commit")
	assert.Equal(t, 1, strings.Count(rec.commits[0], "object(oid"))
}

// The row is what it was when one request read every commit in full.
func TestFetch_MainBranch_TheCheckedCommitLookupPicksTheSameCommitAsReadingEveryCommitInFull(t *testing.T) {
	t.Parallel()

	oid := func(n int) string { return fmt.Sprintf("%040d", n) }
	skipCI := commitOf(oid(1), "chore: [skip ci]", nil)
	for name, tc := range map[string]struct {
		history []map[string]any
		want    string
		status  dashboard.MainBranchStatus
	}{
		"the commit behind a skip ci commit": {
			history: []map[string]any{skipCI, commitOf(oid(2), "fix: a", passingRollup())},
			want:    oid(2)[:7], status: dashboard.MainBranchPassed,
		},
		"past commits with no checks": {
			history: []map[string]any{skipCI, commitOf(oid(2), "a", nil), commitOf(oid(3), "b", nil), commitOf(oid(4), "c", passingRollup())},
			want:    oid(4)[:7], status: dashboard.MainBranchPassed,
		},
		"past a commit with only Dependabot Updates runs": {
			history: []map[string]any{skipCI, commitOf(oid(2), "bump", dependabotRollup()), commitOf(oid(3), "fix", passingRollup())},
			want:    oid(3)[:7], status: dashboard.MainBranchPassed,
		},
		"no commit with checks": {
			history: []map[string]any{skipCI, commitOf(oid(2), "a", nil)},
			want:    oid(1)[:7], status: dashboard.MainBranchNone,
		},
		"only Dependabot Updates runs": {
			history: []map[string]any{skipCI, commitOf(oid(2), "bump", dependabotRollup())},
			want:    oid(1)[:7], status: dashboard.MainBranchNone,
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := &lookupRecorder{commitBy: func(int) []map[string]any { return tc.history }}
			srv := rec.serve(t, 1)

			result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

			require.Len(t, result.MainBranches, 1)
			require.NotNil(t, result.MainBranches[0].Commit)
			assert.Equal(t, tc.want, result.MainBranches[0].Commit.SHA)
			assert.Equal(t, tc.status, result.MainBranches[0].Status)
		})
	}
}

// Many repos with an unchecked newest commit never share one request.
func TestFetch_MainBranch_TheCheckedCommitLookupChunksRepos(t *testing.T) {
	t.Parallel()

	const repos = 60
	rec := &lookupRecorder{commitBy: func(int) []map[string]any {
		return []map[string]any{
			commitOf(fmt.Sprintf("%040d", 1), "chore: [skip ci]", nil),
			commitOf(fmt.Sprintf("%040d", 2), "fix: a", passingRollup()),
		}
	}}
	srv := rec.serve(t, repos)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	assert.Len(t, result.MainBranches, repos)
	var widest int
	for _, q := range append(append([]string{}, rec.history...), rec.commits...) {
		widest = max(widest, len(aliasedFields.FindAllString(q, -1)))
	}
	assert.LessOrEqual(t, widest, maxLookupAliases)
	assert.Greater(t, len(rec.history), 1, "60 repos take more than one request")
}

// The budget: no request of the lookup can return more than maxRequestNodes
// nodes, so the lookup can't grow back into the request that timed out.
func TestFetch_MainBranch_NoRequestOfTheCheckedCommitLookupCanReturnMoreThanTheNodeBudget(t *testing.T) {
	t.Parallel()

	const repos = 60
	rec := &lookupRecorder{commitBy: func(int) []map[string]any {
		return []map[string]any{
			commitOf(fmt.Sprintf("%040d", 1), "chore: [skip ci]", nil),
			commitOf(fmt.Sprintf("%040d", 2), "fix: a", passingRollup()),
		}
	}}
	srv := rec.serve(t, repos)

	github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.NotEmpty(t, rec.commits)
	var biggest int
	for _, q := range append(append([]string{}, rec.history...), rec.commits...) {
		biggest = max(biggest, nodeBudget(q))
	}
	t.Logf("largest request can return %d nodes", biggest)
	assert.LessOrEqual(t, biggest, maxRequestNodes)
}
