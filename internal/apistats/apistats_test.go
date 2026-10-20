package apistats_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
)

func find(t *testing.T, c *apistats.Counters, key apistats.Key) apistats.Count {
	t.Helper()
	for _, b := range c.Snapshot() {
		if b.Key == key {
			return b.Count
		}
	}

	return apistats.Count{}
}

func get(ctx context.Context, t *testing.T, client *http.Client, url string) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
}

func okServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)

	return srv
}

func TestTransportCountsRESTUnderKindAndRepo(t *testing.T) {
	srv := okServer(t)
	c := apistats.New()
	client := &http.Client{Transport: apistats.Transport(nil, c, "github", "token:ab12")}

	ctx := apistats.WithRepo(apistats.WithKind(context.Background(), apistats.KindScopedWebhook), "owner/repo")
	get(ctx, t, client, srv.URL+"/repos/owner/repo/pulls")

	got := find(t, c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindScopedWebhook, Repo: "owner/repo"})
	if got.REST != 1 || got.GraphQL != 0 || got.NotModified != 0 {
		t.Fatalf("got %+v, want one REST call", got)
	}
}

func TestTransportCountsGraphQLSeparatelyAndAddsCost(t *testing.T) {
	srv := okServer(t)
	c := apistats.New()
	client := &http.Client{Transport: apistats.Transport(nil, c, "github", "app:7")}

	ctx := apistats.WithRepo(apistats.WithKind(context.Background(), apistats.KindScopedWebhook), "owner/repo")
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/graphql", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	c.AddCost(ctx, "github", "app:7", 3)

	got := find(t, c, apistats.Key{Forge: "github", Credential: "app:7", Kind: apistats.KindScopedWebhook, Repo: "owner/repo"})
	if got.GraphQL != 1 || got.GraphQLCost != 3 || got.REST != 0 {
		t.Fatalf("got %+v, want one GraphQL call costing 3", got)
	}
}

func TestTransportCountsA304AsNotModifiedNotREST(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotModified)
	}))
	defer srv.Close()
	c := apistats.New()
	client := &http.Client{Transport: apistats.Transport(nil, c, "github", "token:ab12")}

	get(apistats.WithKind(context.Background(), apistats.KindHookMaintenance), t, client, srv.URL+"/repos/o/r/hooks")

	got := find(t, c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindHookMaintenance})
	if got.NotModified != 1 || got.REST != 0 {
		t.Fatalf("got %+v, want one not-modified and no REST", got)
	}
}

func TestUntaggedCallIsCountedAsUnknown(t *testing.T) {
	srv := okServer(t)
	c := apistats.New()
	client := &http.Client{Transport: apistats.Transport(nil, c, "forgejo", "user:ryan")}

	get(context.Background(), t, client, srv.URL+"/api/v1/user")

	got := find(t, c, apistats.Key{Forge: "forgejo", Credential: "user:ryan", Kind: apistats.KindUnknown})
	if got.REST != 1 {
		t.Fatalf("got %+v, want the call under unknown", got)
	}
}

func TestTwoCallsOnOneCredentialShareARow(t *testing.T) {
	srv := okServer(t)
	c := apistats.New()
	a := &http.Client{Transport: apistats.Transport(nil, c, "github", "token:ab12")}
	b := &http.Client{Transport: apistats.Transport(nil, c, "github", "token:ab12")}
	ctx := apistats.WithKind(context.Background(), apistats.KindFull)

	get(ctx, t, a, srv.URL+"/x")
	get(ctx, t, b, srv.URL+"/y")

	if got := find(t, c, apistats.Key{Forge: "github", Credential: "token:ab12", Kind: apistats.KindFull}); got.REST != 2 {
		t.Fatalf("got %+v, want 2 on one row", got)
	}
}

func TestNilCountersAreSafe(t *testing.T) {
	var c *apistats.Counters
	c.AddCost(context.Background(), "github", "x", 1)
	if len(c.Snapshot()) != 0 {
		t.Fatal("nil counters should snapshot empty")
	}
	if rt := apistats.Transport(http.DefaultTransport, nil, "github", "x"); rt != http.DefaultTransport {
		t.Fatal("nil counters should leave the transport untouched")
	}
}

func TestCardinalityIsBounded(t *testing.T) {
	c := apistats.New()
	for i := range apistats.MaxBuckets * 2 {
		c.Add(apistats.Key{Forge: "github", Credential: "x", Kind: apistats.KindFull, Repo: "o/r" + strconv.Itoa(i)}, apistats.Count{REST: 1})
	}
	if n := len(c.Snapshot()); n > apistats.MaxBuckets+1 {
		t.Fatalf("%d buckets, want at most %d", n, apistats.MaxBuckets+1)
	}
	var total int64
	for _, b := range c.Snapshot() {
		total += b.REST
	}
	if total != int64(apistats.MaxBuckets*2) {
		t.Fatalf("total %d, want no call lost to the overflow row", total)
	}
}

func TestSinceIsSetAtStart(t *testing.T) {
	if apistats.New().Since().IsZero() {
		t.Fatal("since must be set")
	}
}
