package github_test

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// authSeen is a GitHub whose discovery answers empty and records every
// Authorization header it was sent.
func authSeen(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()

	var (
		mu   sync.Mutex
		seen []string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		discoveryOK(t, w)
	}))
	t.Cleanup(srv.Close)

	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()

		return append([]string(nil), seen...)
	}
}

func TestBearerClient_Fetch_AsksTheSourceForATokenOnEveryRequest(t *testing.T) {
	t.Parallel()

	srv, seen := authSeen(t)
	n := 0
	client := github.NewBearerClient(func() (string, error) {
		n++

		return fmt.Sprintf("ghu-%d", n), nil
	}, "octocat", srv.URL)

	result := client.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.NotEmpty(t, seen())
	assert.Equal(t, "Bearer ghu-1", seen()[0])
}

func TestBearerClient_Fetch_ASourceThatCannotGiveATokenSendsNothingAndFailsTheRead(t *testing.T) {
	t.Parallel()

	srv, seen := authSeen(t)
	client := github.NewBearerClient(func() (string, error) { return "", errors.New("disconnected") }, "octocat", srv.URL)

	result := client.Fetch(t.Context())

	assert.False(t, result.Health.Reachable)
	assert.Empty(t, seen())
}
