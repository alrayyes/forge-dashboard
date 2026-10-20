package forgejo_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every call the Gitea SDK makes goes through the client's http.Client, so
// counting there covers the calls recordRequest never sees.
func TestSetStats_CountsEverySDKCallUnderKindAndRepo(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	counters := apistats.New()
	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetStats(counters, "user:alrayyes")

	ctx := apistats.WithRepo(apistats.WithKind(context.Background(), apistats.KindFull), "alrayyes/a")
	_, err := client.ListOpenPullRequests(ctx, "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)

	var rest int64
	for _, b := range counters.Snapshot() {
		if b.Forge == "forgejo" && b.Credential == "user:alrayyes" && b.Kind == apistats.KindFull && b.Repo == "alrayyes/a" {
			rest += b.REST
		}
	}
	assert.Positive(t, rest)
}

// The Gitea SDK keeps one context per client. Each call gets its own, so a
// kind set for one call is never counted against another running beside it.
func TestSetStats_ConcurrentCallsKeepTheirOwnKind(t *testing.T) {
	t.Parallel()

	var inFlight sync.WaitGroup
	const callers = 8
	inFlight.Add(callers)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/", func(w http.ResponseWriter, _ *http.Request) {
		// Hold every request until all callers have one in flight.
		inFlight.Done()
		inFlight.Wait()
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	counters := apistats.New()
	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetStats(counters, "token:cd34")

	kinds := []apistats.Kind{
		apistats.KindFull, apistats.KindScopedWebhook, apistats.KindCIPoll, apistats.KindAutoMergePoll,
		apistats.KindDetails, apistats.KindHookMaintenance, apistats.KindUserAction, apistats.KindFull,
	}
	var wg sync.WaitGroup
	for i, kind := range kinds {
		wg.Go(func() {
			ctx := apistats.WithKind(context.Background(), kind)
			_, err := client.ListOpenPullRequests(ctx, "alrayyes", fmt.Sprintf("r%d", i), fmt.Sprintf("alrayyes/r%d", i))
			assert.NoError(t, err)
		})
	}
	wg.Wait()

	for _, b := range counters.Snapshot() {
		var i int
		_, err := fmt.Sscanf(b.Repo, "alrayyes/r%d", &i)
		require.NoError(t, err)
		assert.Equal(t, kinds[i], b.Kind, "repo %s counted under the wrong kind", b.Repo)
	}
}

func TestClientWithoutStats_StillListsPullRequests(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	}))
	defer srv.Close()
	client := forgejo.NewClient(srv.URL, "test-token", "")
	client.SetStats(nil, "user:alrayyes")

	_, err := client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	assert.NoError(t, err)
}
