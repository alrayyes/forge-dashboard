package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// issueNode is repoNodeWithOwnerName's own issue-fixture counterpart —
// GitHub's GraphQL issues connection, one node.
func issueNode(number int, title string) map[string]any {
	return map[string]any{
		"number": number, "title": title, "url": "https://github.com/alrayyes/a/issues/1",
		"author":    map[string]any{"login": "someone"},
		"labels":    map[string]any{"nodes": []map[string]any{}},
		"createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
	}
}

// repoNodeWithIssues is repoNodeWithOwnerName's own counterpart carrying
// real issues data plus the reconciliation-only issuesTotal alias, for
// the tests in this file that need to control both explicitly rather
// than accept repoNodeWithOwnerName's own empty defaults.
func repoNodeWithIssues(owner, name string, totalCount int, issues []map[string]any) map[string]any {
	return map[string]any{
		"name": name, "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": owner},
		"pullRequests": map[string]any{"nodes": []map[string]any{}},
		"issuesTotal":  map[string]any{"totalCount": totalCount},
		"issues":       map[string]any{"nodes": issues},
	}
}

func reposPage(nodes ...map[string]any) map[string]any {
	return map[string]any{
		"data": map[string]any{
			"viewer": map[string]any{
				"repositories": map[string]any{
					"pageInfo": map[string]any{"hasNextPage": false},
					"nodes":    nodes,
				},
			},
		},
	}
}

// TestFetch_FirstPoll_OmitsSince is #381's other half of the same
// acceptance criterion phrased the other way round: a client with no
// prior successful poll has nothing to filter *from*, so the very first
// Fetch has to ask for every open issue unconditionally rather than
// sending some zero-value time.Time that would filter almost everything
// out.
func TestFetch_FirstPoll_OmitsSince(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		assert.Nil(t, body.Variables["since"], "no prior poll to filter since")
		writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 1, []map[string]any{issueNode(1, "first")})))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Issues, 1)
	assert.Equal(t, 1, result.Issues[0].Number)
}

// TestFetch_SecondPoll_PassesSinceFromFirstPoll is the acceptance
// criterion's own words: "it passes filterBy: { since: <last successful
// poll time> } rather than re-fetching every open issue's full data
// unconditionally."
func TestFetch_SecondPoll_PassesSinceFromFirstPoll(t *testing.T) {
	t.Parallel()

	call := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		call++
		body := readGraphQLRequest(t, r)
		if call == 1 {
			assert.Nil(t, body.Variables["since"])
		} else {
			assert.NotEmpty(t, body.Variables["since"], "a repeat poll should offer back the last poll's own time")
		}
		writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 1, []map[string]any{issueNode(1, "first")})))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.Fetch(t.Context())
	client.Fetch(t.Context())

	assert.Equal(t, 2, call)
}

// TestFetch_ReconcileMerge_TotalCountMatches_KeepsUntouchedIssues is the
// core reconciliation property: a since-filtered delta only ever
// describes what changed, so an issue that didn't change has to survive
// from the previous poll's own data rather than silently vanishing
// because this poll's own query never mentioned it — totalCount matching
// (prev ∪ delta) is what proves nothing closed in between, and only then
// is it safe to trust the merge instead of a full refetch.
func TestFetch_ReconcileMerge_TotalCountMatches_KeepsUntouchedIssues(t *testing.T) {
	t.Parallel()

	call := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		call++
		body := readGraphQLRequest(t, r)
		if call == 1 {
			// Full first poll: both issues untouched, both come back.
			writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 2, []map[string]any{
				issueNode(1, "first"), issueNode(2, "second"),
			})))

			return
		}
		// Second poll: only #1 changed since — #2 never closed, so
		// totalCount is still 2, but the delta itself only mentions #1.
		require.NotEmpty(t, body.Variables["since"])
		writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 2, []map[string]any{
			issueNode(1, "first, retitled"),
		})))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.Fetch(t.Context())
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Issues, 2, "the untouched #2 has to survive the merge, not just the delta's own #1")
	byNumber := map[int]string{}
	for _, i := range result.Issues {
		byNumber[i.Number] = i.Title
	}
	assert.Equal(t, "first, retitled", byNumber[1])
	assert.Equal(t, "second", byNumber[2])
}

// TestFetch_ReconcileMismatch_FallsBackToFetchRepo is the other half:
// totalCount dropping below (prev ∪ delta) means something closed since
// the last poll, which a since-filtered issues(states: OPEN) query can
// never reveal on its own (a closed issue just stops appearing — it
// doesn't show up as a tombstone). The merge can't be trusted in that
// case, so the repo falls back to a real full refetch instead of quietly
// keeping a closed issue on the board forever.
func TestFetch_ReconcileMismatch_FallsBackToFetchRepo(t *testing.T) {
	t.Parallel()

	call := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		call++
		body := readGraphQLRequest(t, r)
		if _, isRepoFetch := body.Variables["owner"]; isRepoFetch {
			// The single-repo fallback query FetchRepo already uses —
			// the true current state, #2 having actually closed.
			writeJSON(t, w, map[string]any{
				"data": map[string]any{
					"repository": map[string]any{
						"pullRequests": map[string]any{"nodes": []map[string]any{}},
						"issues":       map[string]any{"nodes": []map[string]any{issueNode(1, "first")}},
					},
				},
			})

			return
		}
		if call == 1 {
			writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 2, []map[string]any{
				issueNode(1, "first"), issueNode(2, "second"),
			})))

			return
		}
		// Second poll: nothing in the delta (nothing was *updated*),
		// but totalCount fell to 1 — #2 closed without ever appearing
		// in a since-filtered delta.
		writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 1, []map[string]any{})))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.Fetch(t.Context())
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.Issues, 1, "the mismatch should have triggered a real refetch instead of trusting the stale merge")
	assert.Equal(t, 1, result.Issues[0].Number)
}

// TestFetch_NewRepoOnASinceFilteredPoll_FullyFetchedViaFallback pins the
// subtler version of the same mismatch case: a repo this client has
// never seen before has no prior state to merge from at all, and the
// same global $since already applies to its own issues connection in
// this batched query too — so an old, untouched issue in a brand-new
// repo could vanish the same way a closed one does, unless the zero
// previous-state count itself mismatches totalCount and forces the same
// fallback.
func TestFetch_NewRepoOnASinceFilteredPoll_FullyFetchedViaFallback(t *testing.T) {
	t.Parallel()

	call := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		call++
		body := readGraphQLRequest(t, r)
		if _, isRepoFetch := body.Variables["owner"]; isRepoFetch {
			writeJSON(t, w, map[string]any{
				"data": map[string]any{
					"repository": map[string]any{
						"pullRequests": map[string]any{"nodes": []map[string]any{}},
						"issues":       map[string]any{"nodes": []map[string]any{issueNode(9, "old, untouched")}},
					},
				},
			})

			return
		}
		if call == 1 {
			writeJSON(t, w, reposPage(repoNodeWithIssues("alrayyes", "a", 0, []map[string]any{})))

			return
		}
		// Second poll: repo b is new to this client. Its one open issue
		// predates $since and never shows up in the delta, but
		// totalCount still says 1.
		writeJSON(t, w, reposPage(
			repoNodeWithIssues("alrayyes", "a", 0, []map[string]any{}),
			repoNodeWithIssues("alrayyes", "b", 1, []map[string]any{}),
		))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.Fetch(t.Context())
	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	var bIssues []string
	for _, i := range result.Issues {
		if i.Repo == "alrayyes/b" {
			bIssues = append(bIssues, i.Title)
		}
	}
	require.Len(t, bIssues, 1, "the new repo's real, pre-existing issue should have come from the fallback refetch")
	assert.Equal(t, "old, untouched", bIssues[0])
}
