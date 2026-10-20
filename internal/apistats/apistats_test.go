package apistats_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func find(c *apistats.Counters, key apistats.Key) apistats.Count {
	for _, b := range c.Snapshot() {
		if b.Key == key {
			return b.Count
		}
	}

	return apistats.Count{}
}

func do(ctx context.Context, t *testing.T, client *http.Client, method, url string) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	require.NoError(t, err)
	resp, err := client.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
}

func okServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)

	return srv
}

func countingClient(c *apistats.Counters, forge, credential string) *http.Client {
	return &http.Client{Transport: apistats.Transport(nil, c, forge, credential)}
}

func TestTransport_CountsRESTUnderKindAndRepo(t *testing.T) {
	t.Parallel()

	srv := okServer(t)
	c := apistats.New()
	ctx := apistats.WithRepo(apistats.WithKind(t.Context(), apistats.KindScopedWebhook), "owner/repo")

	do(ctx, t, countingClient(c, "github", "token:ab12"), http.MethodGet, srv.URL+"/user")

	got := find(c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindScopedWebhook, Repo: "owner/repo"})
	assert.EqualValues(t, 1, got.REST)
	assert.Zero(t, got.GraphQL+got.NotModified)
}

func TestTransport_CountsGraphQLSeparatelyAndAddsCost(t *testing.T) {
	t.Parallel()

	srv := okServer(t)
	c := apistats.New()
	ctx := apistats.WithRepo(apistats.WithKind(t.Context(), apistats.KindScopedWebhook), "owner/repo")

	do(ctx, t, countingClient(c, "github", "app:7"), http.MethodPost, srv.URL+"/graphql")
	c.AddCost(ctx, "github", "app:7", 3)

	got := find(c, apistats.Key{Forge: "github", Credential: "app:7", Kind: apistats.KindScopedWebhook, Repo: "owner/repo"})
	assert.EqualValues(t, 1, got.GraphQL)
	assert.EqualValues(t, 3, got.GraphQLCost)
	assert.Zero(t, got.REST)
}

func TestTransport_CountsA304AsNotModifiedNotREST(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotModified) }))
	defer srv.Close()
	c := apistats.New()

	do(apistats.WithKind(t.Context(), apistats.KindHookMaintenance), t, countingClient(c, "github", "token:ab12"), http.MethodGet, srv.URL+"/repos/o/r/hooks")

	got := find(c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindHookMaintenance, Repo: "o/r"})
	assert.EqualValues(t, 1, got.NotModified)
	assert.Zero(t, got.REST)
}

func TestTransport_AnUntaggedCallIsCountedAsUnknown(t *testing.T) {
	t.Parallel()

	srv := okServer(t)
	c := apistats.New()

	do(t.Context(), t, countingClient(c, "forgejo", "token:cd34"), http.MethodGet, srv.URL+"/api/v1/user")

	assert.EqualValues(t, 1, find(c, apistats.Key{Forge: "forgejo", Credential: "token:cd34", Kind: apistats.KindUnknown}).REST)
}

func TestTransport_TwoClientsOnOneCredentialShareARow(t *testing.T) {
	t.Parallel()

	srv := okServer(t)
	c := apistats.New()
	ctx := apistats.WithKind(t.Context(), apistats.KindFull)

	do(ctx, t, countingClient(c, "github", "token:ab12"), http.MethodGet, srv.URL+"/x")
	do(ctx, t, countingClient(c, "github", "token:ab12"), http.MethodGet, srv.URL+"/y")

	assert.EqualValues(t, 2, find(c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindFull}).REST)
}

func TestTransport_RepoComesFromTheURLWhenThePathNamesOne(t *testing.T) {
	t.Parallel()

	srv := okServer(t)
	c := apistats.New()
	// The context names another repo, as a shared SDK context can after a race.
	ctx := apistats.WithRepo(apistats.WithKind(t.Context(), apistats.KindFull), "someone/else")

	do(ctx, t, countingClient(c, "forgejo", "token:cd34"), http.MethodGet, srv.URL+"/api/v1/repos/alrayyes/a/pulls")

	assert.EqualValues(t, 1, find(c, apistats.Key{Forge: "forgejo", Credential: "token:cd34", Kind: apistats.KindFull, Repo: "alrayyes/a"}).REST)
}

func TestTransport_AnAccountWideListingHasNoRepo(t *testing.T) {
	t.Parallel()

	srv := okServer(t)
	c := apistats.New()

	do(apistats.WithKind(t.Context(), apistats.KindFull), t, countingClient(c, "forgejo", "token:cd34"), http.MethodGet, srv.URL+"/api/v1/user/repos")

	assert.EqualValues(t, 1, find(c, apistats.Key{Forge: "forgejo", Credential: "token:cd34", Kind: apistats.KindFull}).REST)
}

type failingTransport struct{ err error }

func (f failingTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, f.err }

func TestTransport_ReturnsTheBaseTransportsErrorUnchangedAndStillCountsTheCall(t *testing.T) {
	t.Parallel()

	c := apistats.New()
	boom := errors.New("connection refused")
	req, err := http.NewRequestWithContext(apistats.WithKind(t.Context(), apistats.KindFull), http.MethodGet, "http://forge.invalid/user", nil)
	require.NoError(t, err)

	resp, err := apistats.Transport(failingTransport{err: boom}, c, "github", "token:ab12").RoundTrip(req) //nolint:bodyclose // a failed round trip has no body

	require.ErrorIs(t, err, boom)
	assert.Nil(t, resp)
	assert.EqualValues(t, 1, find(c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindFull}).REST)
}

func TestNilCounters_AreSafe(t *testing.T) {
	t.Parallel()

	var c *apistats.Counters
	c.AddCost(t.Context(), "github", "x", 1)

	assert.Empty(t, c.Snapshot())
	assert.True(t, c.Since().IsZero())
	assert.Same(t, http.DefaultTransport, apistats.Transport(http.DefaultTransport, nil, "github", "x"), "no counters leaves the transport as it was")
}

func TestCounters_CardinalityIsBoundedAndNoCallIsLost(t *testing.T) {
	t.Parallel()

	c := apistats.New()
	for i := range apistats.MaxBuckets * 2 {
		c.Add(apistats.Key{Forge: "github", Credential: "x", Kind: apistats.KindFull, Repo: "o/r" + strconv.Itoa(i)}, apistats.Count{REST: 1})
	}

	var total int64
	for _, b := range c.Snapshot() {
		total += b.REST
	}
	assert.LessOrEqual(t, len(c.Snapshot()), apistats.MaxBuckets+1)
	assert.EqualValues(t, apistats.MaxBuckets*2, total)
}

func TestCounters_SayWhenCountingBegan(t *testing.T) {
	t.Parallel()

	assert.False(t, apistats.New().Since().IsZero())
}

func TestCredentialLabels_CarryNoSecret(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "app:7", apistats.AppCredential(7))
	assert.NotContains(t, apistats.TokenCredential("ghp_secret"), "secret")
	label := apistats.TokenCredential("ghp_secret")
	assert.Equal(t, label, apistats.TokenCredential("ghp_secret"), "one token, one label")
	assert.NotEqual(t, apistats.TokenCredential("a"), apistats.TokenCredential("b"))
}
