package forgejo_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSetBearerSource_EveryRequestCarriesTheCurrentAccessToken(t *testing.T) {
	t.Parallel()

	var (
		mu   sync.Mutex
		seen []string
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tokens := []string{"access-1", "access-2"}
	calls := 0
	client := forgejo.NewClient(srv.URL, "", "")
	client.SetBearerSource(func() (string, error) {
		tok := tokens[calls]
		calls++

		return tok, nil
	})

	_, err := client.ListRepos(t.Context())
	require.NoError(t, err)
	_, err = client.ListRepos(t.Context())
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{"Bearer access-1", "Bearer access-2"}, seen, "the token is asked for per request, so a refresh reaches the next call")
}

func TestSetBearerSource_ATokenThatCannotBeHadSendsNothing(t *testing.T) {
	t.Parallel()

	var hits int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		writeJSON(t, w, []map[string]any{})
	}))
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "", "")
	client.SetBearerSource(func() (string, error) { return "", errors.New("refresh failed") })

	_, err := client.ListRepos(t.Context())

	require.Error(t, err)
	mu.Lock()
	defer mu.Unlock()
	assert.Zero(t, hits, "no request goes out without a valid token, and never with a stale one")
}
