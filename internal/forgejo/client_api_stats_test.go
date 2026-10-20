package forgejo_test

import (
	"context"
	"net/http"
	"net/http/httptest"
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
