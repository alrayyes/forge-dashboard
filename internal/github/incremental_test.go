package github_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const incrementalHookPath = "/api/webhooks/github/tok123"

// incrementalServer is a GitHub that tells the three GraphQL shapes a refresh
// can send apart (the cheap probe, the account-wide listing, a batch of named
// repos) and counts each, so a test can assert what a refresh cost.
type incrementalServer struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	pushedAt   map[string]string // repo name -> pushedAt in the probe
	noHook     map[string]bool
	hookEvents map[string][]string // repo name -> events its hook subscribes to
	inactive   map[string]bool
	missing    map[string]bool // repo name -> left out of the batch answer
	probeFails bool
	probes     int
	listings   int
	batches    [][]string // repo names per batch call
	hookReads  int
	sinces     []any // the since variable of each batch
}

func newIncrementalServer(t *testing.T, repos ...string) *incrementalServer {
	t.Helper()

	s := &incrementalServer{t: t, pushedAt: map[string]string{}, noHook: map[string]bool{}, hookEvents: map[string][]string{}, inactive: map[string]bool{}, missing: map[string]bool{}}
	for _, r := range repos {
		s.pushedAt[r] = "2026-01-01T00:00:00Z"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", s.graphql)
	mux.HandleFunc("/repos/alrayyes/", s.hooks)
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)

	return s
}

func (s *incrementalServer) hooks(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 || parts[3] != "hooks" {
		http.NotFound(w, r)

		return
	}
	s.hookReads++
	if s.noHook[parts[2]] {
		writeJSON(s.t, w, []map[string]any{})

		return
	}
	events := []string{"pull_request", "check_run"}
	if e, ok := s.hookEvents[parts[2]]; ok {
		events = e
	}
	writeJSON(s.t, w, []map[string]any{{
		"id": 1, "active": !s.inactive[parts[2]], "events": events,
		"config": map[string]any{"url": "https://dashboard.example" + incrementalHookPath},
	}})
}

func (s *incrementalServer) graphql(w http.ResponseWriter, r *http.Request) {
	body := readGraphQLRequest(s.t, r)
	s.mu.Lock()
	defer s.mu.Unlock()

	switch {
	case strings.Contains(body.Query, "pushedAt"):
		s.probes++
		if s.probeFails {
			http.Error(w, "boom", http.StatusInternalServerError)

			return
		}
		var nodes []map[string]any
		for name, pushed := range s.pushedAt {
			nodes = append(nodes, map[string]any{
				"name": name, "url": "https://github.com/alrayyes/" + name, "isArchived": false, "isFork": false,
				"viewerPermission": "ADMIN", "owner": map[string]any{"login": "alrayyes"},
				"pushedAt": pushed, "updatedAt": pushed,
				"openPRs":    map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
				"openIssues": map[string]any{"totalCount": 0, "nodes": []map[string]any{}},
			})
		}
		writeJSON(s.t, w, reposPage(nodes...))
	case strings.Contains(body.Query, "repositories("):
		s.listings++
		var nodes []map[string]any
		for name := range s.pushedAt {
			nodes = append(nodes, repoNodeWithIssues(name, 0, nil))
		}
		writeJSON(s.t, w, reposPage(nodes...))
	default:
		var batch []string
		data := map[string]any{}
		for i := 0; ; i++ {
			owner, ok := body.Variables["owner"+itoa(i)]
			if !ok {
				break
			}
			name, _ := body.Variables["name"+itoa(i)].(string)
			assert.Equal(s.t, "alrayyes", owner)
			batch = append(batch, name)
			if s.missing[name] {
				data["r"+itoa(i)] = nil

				continue
			}
			data["r"+itoa(i)] = map[string]any{
				"pullRequests": map[string]any{"nodes": []map[string]any{}},
				"issuesTotal":  map[string]any{"totalCount": 0},
				"issues":       map[string]any{"nodes": []map[string]any{}},
			}
		}
		s.batches = append(s.batches, batch)
		s.sinces = append(s.sinces, body.Variables["since"])
		writeJSON(s.t, w, map[string]any{"data": data})
	}
}

func itoa(i int) string { return strconv.Itoa(i) }

func (s *incrementalServer) client() *github.Client {
	c := github.NewClient("test-token", "", s.srv.URL)
	c.SetWebhookPath(incrementalHookPath)

	return c
}

func (s *incrementalServer) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.probes, s.listings, s.batches, s.hookReads, s.sinces = 0, 0, nil, 0, nil
}

func TestFetch_Incremental_NothingChanged_OnlyTheProbeAndHookChecks(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b", "c")
	client := s.client()
	client.Fetch(t.Context()) // a full pass records what each repo looked like
	s.reset()

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	require.True(t, result.Health.Reachable)
	assert.ElementsMatch(t, []string{"alrayyes/a", "alrayyes/b", "alrayyes/c"}, result.Unchanged)
	assert.Equal(t, 1, s.probes, "one cheap probe for the whole account")
	assert.Zero(t, s.listings, "no account-wide query")
	assert.Empty(t, s.batches, "no per-repo query")
	assert.Equal(t, 3, s.hookReads, "hook health stays current for a skipped repo")
	assert.Len(t, result.Repos, 3, "every tracked repo still has its repo row")
	assert.Empty(t, result.PullRequests)
}

func TestFetch_Incremental_TwoReposChanged_OnlyThoseAreFetched(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b", "c")
	client := s.client()
	client.Fetch(t.Context())
	s.reset()
	s.pushedAt["a"] = "2026-02-01T00:00:00Z"
	s.pushedAt["c"] = "2026-02-02T00:00:00Z"

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	require.Len(t, s.batches, 1)
	assert.ElementsMatch(t, []string{"a", "c"}, s.batches[0])
	assert.Zero(t, s.listings)
	assert.Equal(t, []string{"alrayyes/b"}, result.Unchanged)
}

func TestFetch_Incremental_RepoWithoutConfirmedWebhook_CountsAsChanged(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")
	s.noHook["b"] = true
	client := s.client()
	client.Fetch(t.Context())
	s.reset()

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	require.Len(t, s.batches, 1)
	assert.Equal(t, []string{"b"}, s.batches[0])
	assert.Equal(t, []string{"alrayyes/a"}, result.Unchanged)
}

func TestFetch_Incremental_NoWebhookConfigured_FetchesEverything(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")
	client := github.NewClient("test-token", "", s.srv.URL)
	client.Fetch(t.Context())
	s.reset()

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	assert.Empty(t, result.Unchanged)
	assert.Equal(t, 1, s.listings)
	assert.Zero(t, s.probes, "with no webhook nothing could be skipped, so no probe")
}

func TestFetch_Incremental_ProbeFails_FetchesEverything(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")
	client := s.client()
	client.Fetch(t.Context())
	s.reset()
	s.probeFails = true

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	require.True(t, result.Health.Reachable)
	assert.Empty(t, result.Unchanged)
	assert.Equal(t, 1, s.listings, "a probe that cannot be trusted means the account-wide query")
}

func TestFetch_NotIncremental_FetchesEverythingWhateverTheProbeSays(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")
	client := s.client()
	client.Fetch(t.Context())
	s.reset()

	result := client.Fetch(t.Context())

	assert.Empty(t, result.Unchanged)
	assert.Equal(t, 1, s.listings)
	assert.Empty(t, s.batches)
}

func TestFetch_Incremental_BeforeAnyFetch_FetchesEverything(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")

	result := s.client().Fetch(dashboard.WithIncremental(t.Context()))

	assert.Empty(t, result.Unchanged, "a fresh process has recorded nothing to compare with")
	assert.Equal(t, 1, s.listings)
}

func TestFetch_Incremental_IssuesSinceAdvancesOnlyForFetchedRepos(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")
	client := s.client()
	client.Fetch(t.Context())
	first := client.IssueSinceForTest("alrayyes/b")
	require.NotNil(t, first)
	s.pushedAt["a"] = "2026-02-01T00:00:00Z"

	client.Fetch(dashboard.WithIncremental(t.Context()))

	assert.Equal(t, first, client.IssueSinceForTest("alrayyes/b"), "the skipped repo's marker stays where it was")
	advanced := client.IssueSinceForTest("alrayyes/a")
	require.NotNil(t, advanced)
	assert.True(t, advanced.After(*first), "the fetched repo's marker moves on")
}

func TestFetch_Incremental_HookThatMissesCheckEvents_CountsAsChanged(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b", "c")
	s.hookEvents["b"] = []string{"push", "pull_request"}
	s.inactive["c"] = true
	client := s.client()
	client.Fetch(t.Context())
	s.reset()

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	require.Len(t, s.batches, 1)
	assert.ElementsMatch(t, []string{"b", "c"}, s.batches[0],
		"a hook that isn't active, or doesn't deliver checks, can't vouch for a skipped repo")
	assert.Equal(t, []string{"alrayyes/a"}, result.Unchanged)
}

func TestFetch_Incremental_ChangedRepoMissingFromTheAnswer_IsReportedFailed(t *testing.T) {
	t.Parallel()

	s := newIncrementalServer(t, "a", "b")
	client := s.client()
	client.Fetch(t.Context())
	s.reset()
	s.pushedAt["a"] = "2026-02-01T00:00:00Z"
	s.missing["a"] = true

	result := client.Fetch(dashboard.WithIncremental(t.Context()))

	assert.Equal(t, []dashboard.FailedRepo{{FullName: "alrayyes/a", PullRequests: true, Issues: true, MainBranch: true}},
		result.FailedRepos, "its earlier rows are kept rather than dropped")
}
