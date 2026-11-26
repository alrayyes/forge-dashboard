package api_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// authRecorder is an image host that remembers the Authorization it was sent.
func authRecorder(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(s.Close)

	return s, func() []string {
		mu.Lock()
		defer mu.Unlock()

		return append([]string{}, seen...)
	}
}

// federatedAt stands a local server in for the federated avatar hosts.
func federatedAt(s *httptest.Server) func(*api.Deps) {
	hosts := []string{s.Listener.Addr().String()}

	return func(d *api.Deps) {
		d.FederatedAvatars = &api.FederatedAvatars{
			Hosts: hosts,
			Proxy: imageproxy.New(imageproxy.Config{Hosts: hosts, Scheme: "http", AllowLocal: true}),
		}
	}
}

func imageStatus(t *testing.T, srv string, cookie *http.Cookie, raw, kind string) int {
	t.Helper()
	q := url.Values{"forge": {"forgejo"}, "url": {raw}}
	if kind != "" {
		q.Set("kind", kind)
	}
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()

	return resp.StatusCode
}

func TestImages_FetchesAFederatedAvatarWithoutTheToken(t *testing.T) {
	t.Parallel()
	forge := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(forge.Close)
	federated, seen := authRecorder(t)
	srv, cookie := imagesServer(t, forge, federatedAt(federated))

	assert.Equal(t, http.StatusForbidden, imageStatus(t, srv, cookie, federated.URL+"/avatar/a", ""), "not for an embedded image")
	assert.Empty(t, seen())
	assert.Equal(t, http.StatusOK, imageStatus(t, srv, cookie, federated.URL+"/avatar/a", "avatar"))
	assert.Equal(t, []string{""}, seen(), "one request, with no token")
}

// A saved instance that is itself on the federated list stays on the forge's
// own proxy, token and all.
func TestImages_ASavedInstanceOnTheFederatedListKeepsItsOwnProxy(t *testing.T) {
	t.Parallel()
	forge, seen := authRecorder(t)
	srv, cookie := imagesServer(t, forge, federatedAt(forge))

	assert.Equal(t, http.StatusOK, imageStatus(t, srv, cookie, forge.URL+"/avatars/a", "avatar"))
	assert.Equal(t, []string{"token " + imagesToken}, seen())
}
