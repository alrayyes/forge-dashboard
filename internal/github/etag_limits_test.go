package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// namedHooksServer serves any repo's hook listing with an ETag, padding the
// body by padding bytes, and records which requests were conditional.
func namedHooksServer(t *testing.T, padding int) (srv *httptest.Server, wasConditional func(repo string) []bool) {
	t.Helper()
	var mu sync.Mutex
	seen := map[string][]bool{}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/{name}/hooks", func(w http.ResponseWriter, r *http.Request) {
		conditional := r.Header.Get("If-None-Match") != ""
		mu.Lock()
		seen[r.PathValue("name")] = append(seen[r.PathValue("name")], conditional)
		mu.Unlock()
		if conditional {
			w.WriteHeader(http.StatusNotModified)

			return
		}
		w.Header().Set("ETag", `"v1"`)
		if padding == 0 {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{"id": 1, "name": strings.Repeat("x", padding)}})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, func(repo string) []bool {
		mu.Lock()
		defer mu.Unlock()

		return append([]bool(nil), seen[repo]...)
	}
}

func readHooks(t *testing.T, client *github.Client, repos ...string) {
	t.Helper()
	for _, repo := range repos {
		_, err := client.HasWebhook(t.Context(), "alrayyes", repo)
		require.NoError(t, err)
	}
}

func TestETagCache_BodyOverTheCap_IsNeverCached(t *testing.T) {
	t.Parallel()

	srv, conditional := namedHooksServer(t, github.MaxETagBodyBytes+1)
	client := github.NewClient("cap-token", "", srv.URL)
	client.SetWebhookPath("/hook")

	readHooks(t, client, "big", "big")

	assert.Equal(t, []bool{false, false}, conditional("big"), "an oversized body costs a full response each time")
}

func TestETagCache_OverTheEntryLimit_EvictsTheLeastRecentlyUsed(t *testing.T) {
	t.Parallel()

	srv, conditional := namedHooksServer(t, 0)
	client := github.NewClient("lru-token", "", srv.URL)
	client.SetWebhookPath("/hook")
	client.UseETagStoreLimits(2, 1<<20)

	// a and b fill the store, reading a again makes b the oldest, c evicts b.
	readHooks(t, client, "a", "b", "a", "c", "b")

	assert.Equal(t, []bool{false, false}, conditional("b"), "b was evicted, so the second read was a full response")
}

func TestETagCache_OverTheEntryLimit_KeepsTheRecentlyUsed(t *testing.T) {
	t.Parallel()

	srv, conditional := namedHooksServer(t, 0)
	client := github.NewClient("lru-keep-token", "", srv.URL)
	client.SetWebhookPath("/hook")
	client.UseETagStoreLimits(2, 1<<20)

	readHooks(t, client, "a", "b", "a", "c", "a")

	assert.Equal(t, []bool{false, true, true}, conditional("a"), "a stayed cached because it was used last")
}

func TestETagCache_OverTheByteLimit_EvictsTheOldest(t *testing.T) {
	t.Parallel()

	srv, conditional := namedHooksServer(t, 0)
	client := github.NewClient("bytes-token", "", srv.URL)
	client.SetWebhookPath("/hook")
	// Each empty listing is a few bytes of JSON, so two do not fit in 5.
	client.UseETagStoreLimits(100, 5)

	readHooks(t, client, "a", "b", "a")

	assert.Equal(t, []bool{false, false}, conditional("a"), "b pushed a out when the byte limit was passed")
}
