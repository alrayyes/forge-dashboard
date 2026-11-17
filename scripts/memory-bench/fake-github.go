//go:build ignore

// A fake GitHub API for measuring the dashboard's memory (#3554). It serves a
// synthetic account of N repositories through the one account-wide GraphQL
// query a refresh makes, plus empty answers for the REST and GraphQL calls
// around it, so the dashboard has real-sized work to hold without a real
// account. Nothing here is a real name or token.
//
//	go run scripts/memory-bench/fake-github.go -addr :18081 -repos 200
//
// Per repo i (cycling every ten), the open pull requests are 0,0,1,1,1,2,2,3,4,6
// (two on average), the open issues 0,0,0,1,1,2,3,5,8,12 (3.2 on average). A pull
// request carries a 2 KiB body, labels, review threads and eight check runs
// counted in its rollup; the default branch carries ten check runs.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	prsPerRepo    = [10]int{0, 0, 1, 1, 1, 2, 2, 3, 4, 6}
	issuesPerRepo = [10]int{0, 0, 0, 1, 1, 2, 3, 5, 8, 12}
	pageSize      = 50
	body          = strings.Repeat("This PR contains the following updates: package, from 1.2.3 to 1.2.4. Release notes, changelog and configuration follow.\n", 16)
	started       = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)
)

type server struct {
	repos int
	mu    sync.Mutex
	seen  map[string]int
}

func main() {
	addr := flag.String("addr", ":18081", "listen address")
	repos := flag.Int("repos", 200, "repositories in the synthetic account")
	flag.Parse()
	s := &server{repos: *repos, seen: map[string]int{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /graphql", s.graphql)
	mux.HandleFunc("GET /__seen", s.report)
	mux.HandleFunc("GET /__count", s.count)
	mux.HandleFunc("/", s.rest)
	log.Printf("fake github: %d repos on %s", *repos, *addr)
	log.Fatal((&http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe())
}

func (s *server) note(what string) {
	s.mu.Lock()
	s.seen[what]++
	s.mu.Unlock()
}

// count is how many API calls the dashboard has made so far. The run script
// waits for it to stop moving, which is how it knows the first refresh is done.
func (s *server) count(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	for _, n := range s.seen {
		total += n
	}
	_, _ = fmt.Fprint(w, total)
}

func (s *server) report(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = json.NewEncoder(w).Encode(s.seen)
}

// rest answers an empty list for hooks and Dependabot alerts and a not-found
// for anything else.
func (s *server) rest(w http.ResponseWriter, r *http.Request) {
	s.note("REST " + r.Method + " " + restShape(r.URL.Path))
	w.Header().Set("Content-Type", "application/json")
	if strings.HasSuffix(r.URL.Path, "/hooks") || strings.HasSuffix(r.URL.Path, "/dependabot/alerts") {
		_, _ = w.Write([]byte("[]"))

		return
	}
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`{"message":"Not Found"}`))
}

func (s *server) graphql(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)

		return
	}
	w.Header().Set("Content-Type", "application/json")
	rate := map[string]any{"limit": 5000, "cost": 1, "remaining": 4990, "resetAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
	if !strings.Contains(req.Query, "viewer") || !strings.Contains(req.Query, "pullRequests(") {
		s.note("GraphQL other: " + firstLine(req.Query))
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"rateLimit": rate}})

		return
	}
	s.note("GraphQL account-wide page")
	offset := 0
	if c, ok := req.Variables["cursor"].(string); ok {
		offset, _ = strconv.Atoi(c)
	}
	end := min(offset+pageSize, s.repos)
	nodes := make([]any, 0, end-offset)
	for i := offset; i < end; i++ {
		nodes = append(nodes, repoNode(i))
	}
	page := map[string]any{"hasNextPage": end < s.repos, "endCursor": strconv.Itoa(end)}
	repositories := map[string]any{"pageInfo": page, "nodes": nodes}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"rateLimit": rate, "viewer": map[string]any{"repositories": repositories}}})
}

// restShape masks the owner and repo of /repos/{owner}/{repo}/..., so /__seen
// counts one line per kind of call.
func restShape(path string) string {
	parts := strings.SplitN(path, "/", 5)
	if len(parts) == 5 && parts[1] == "repos" {
		return "/repos/{owner}/{repo}/" + parts[4]
	}

	return path
}

func firstLine(q string) string {
	q = strings.TrimSpace(q)
	line, _, _ := strings.Cut(q, "\n")
	if len(line) > 60 {
		line = line[:60]
	}

	return line
}

func repoNode(i int) map[string]any {
	name := fmt.Sprintf("repo-%04d", i)
	prs := make([]any, 0, 6)
	for n := 1; n <= prsPerRepo[i%10]; n++ {
		prs = append(prs, pullRequest(name, i, n))
	}
	issues := make([]any, 0, 12)
	for n := 1; n <= issuesPerRepo[i%10]; n++ {
		issues = append(issues, issue(name, 100+n))
	}

	return map[string]any{
		"name": name, "url": "https://example.test/synthetic/" + name,
		"isArchived": false, "isFork": false, "viewerPermission": "ADMIN",
		"usesCustomOpenGraphImage": false, "openGraphImageUrl": "https://opengraph.example.test/" + name,
		"owner":        map[string]any{"login": "synthetic"},
		"pullRequests": map[string]any{"nodes": prs},
		"issuesTotal":  map[string]any{"totalCount": len(issues)},
		"issues":       map[string]any{"nodes": issues},
		"latestRelease": map[string]any{
			"tagName": "v1.2.3", "url": "https://example.test/synthetic/" + name + "/releases/v1.2.3",
		},
		"defaultBranchRef": defaultBranch(name, i),
	}
}

func author(login string) map[string]any {
	return map[string]any{"login": login, "avatarUrl": "https://avatars.example.test/" + login}
}

func labels() map[string]any {
	return map[string]any{"nodes": []any{
		map[string]any{"name": "dependencies", "color": "0366d6"},
		map[string]any{"name": "automerge", "color": "0e8a16"},
	}}
}

func pullRequest(repo string, i, n int) map[string]any {
	oid := fmt.Sprintf("%040x", i*100+n)
	url := fmt.Sprintf("https://example.test/synthetic/%s/pull/%d", repo, n)

	return map[string]any{
		"number": n, "title": fmt.Sprintf("Update dependency pkg-%d to v%d", n, n+1), "url": url,
		"isDraft": false, "author": author("update-bot"), "mergeStateStatus": "CLEAN",
		"headRefOid": oid, "baseRefName": "main", "headRefName": fmt.Sprintf("bot/pkg-%d", n),
		"body": body, "isCrossRepository": false, "additions": 40, "deletions": 12, "changedFiles": 3,
		"autoMergeRequest": nil, "viewerCanEnableAutoMerge": true, "reviewDecision": nil,
		"reviewRequests":          map[string]any{"totalCount": 0, "nodes": []any{}},
		"closingIssuesReferences": map[string]any{"nodes": []any{}},
		"latestReviews":           map[string]any{"nodes": []any{}},
		"comments":                map[string]any{"totalCount": 2},
		"reviewThreads":           map[string]any{"nodes": []any{map[string]any{"isResolved": true, "comments": map[string]any{"totalCount": 1}}}},
		"labels":                  labels(),
		"createdAt":               started, "updatedAt": started,
		"branchCommits": map[string]any{"totalCount": 1, "nodes": []any{
			map[string]any{"commit": map[string]any{"author": map[string]any{"name": "Update Bot", "user": map[string]any{"login": "update-bot"}}}},
		}},
		"commits": map[string]any{"nodes": []any{map[string]any{"commit": map[string]any{
			"oid": oid,
			"statusCheckRollup": map[string]any{"state": "SUCCESS", "contexts": map[string]any{
				"checkRunCountsByState":      []any{map[string]any{"state": "SUCCESS", "count": 8}},
				"statusContextCountsByState": []any{},
			}},
		}}}},
	}
}

func issue(repo string, n int) map[string]any {
	return map[string]any{
		"number": n, "title": fmt.Sprintf("Synthetic issue %d", n),
		"url":    fmt.Sprintf("https://example.test/synthetic/%s/issues/%d", repo, n),
		"author": author("reporter"), "labels": labels(), "createdAt": started, "updatedAt": started,
	}
}

func defaultBranch(repo string, i int) map[string]any {
	oid := fmt.Sprintf("%040x", i)
	runs := make([]any, 0, 10)
	for n := 0; n < 10; n++ {
		runs = append(runs, map[string]any{
			"__typename": "CheckRun", "databaseId": i*100 + n, "name": fmt.Sprintf("job-%d", n),
			"status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": started, "completedAt": started,
			"detailsUrl": "https://example.test/run", "permalink": "https://example.test/run",
			"checkSuite": map[string]any{"status": "COMPLETED", "conclusion": "SUCCESS", "workflowRun": map[string]any{
				"databaseId": i*10 + n%3, "runAttempt": 1, "runNumber": 7, "event": "push", "workflow": map[string]any{"name": fmt.Sprintf("workflow-%d", n%3)},
			}},
		})
	}
	suites := make([]any, 0, 3)
	for n := 0; n < 3; n++ {
		suites = append(suites, map[string]any{"id": fmt.Sprintf("suite-%d-%d", i, n), "status": "COMPLETED", "conclusion": "SUCCESS",
			"workflowRun": map[string]any{"databaseId": i*10 + n, "runAttempt": 1, "runNumber": 7, "event": "push", "workflow": map[string]any{"name": fmt.Sprintf("workflow-%d", n)}}})
	}

	return map[string]any{"name": "main", "target": map[string]any{
		"oid": oid, "abbreviatedOid": oid[:7], "messageHeadline": "chore: synthetic commit",
		"url": "https://example.test/synthetic/" + repo + "/commit/" + oid, "committedDate": started,
		"author":      map[string]any{"name": "Synthetic Author", "user": map[string]any{"login": "synthetic"}},
		"checkSuites": map[string]any{"nodes": suites},
		"statusCheckRollup": map[string]any{"state": "SUCCESS", "contexts": map[string]any{
			"checkRunCountsByState":      []any{map[string]any{"state": "SUCCESS", "count": 10}},
			"statusContextCountsByState": []any{},
			"nodes":                      runs,
		}},
	}}
}
