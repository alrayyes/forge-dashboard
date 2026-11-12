package api_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var imagesPNG, _ = base64.StdEncoding.DecodeString(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

const imagesToken = "forgejo-token-for-images" //nolint:gosec // a fixture, not a credential

// imagesServer signs in and saves a Forgejo account whose instance is forge, so
// the proxy's allowed host is that test server.
func imagesServer(t *testing.T, forge *httptest.Server) (srv string, cookie *http.Cookie) {
	t.Helper()
	testSrv, _, _, _ := newTestServerWithSettingsStore(t, func(settingspkg.Credentials) []dashboard.Source { return nil }, false, 0)
	cookie, _, _ = registerViaRealCeremony(t, testSrv)

	body, err := json.Marshal(map[string]string{"forgejoUrl": forge.URL, "forgejoToken": imagesToken})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPut, testSrv.URL+"/api/v1/settings", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	return testSrv.URL, cookie
}

func getImage(t *testing.T, srv string, cookie *http.Cookie, forge, raw string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {forge}, "url": {raw}}
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func TestImages_NeedsASession(t *testing.T) {
	t.Parallel()
	forge := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(forge.Close)
	srv, _ := imagesServer(t, forge)

	resp := getImage(t, srv, nil, "forgejo", forge.URL+"/attachments/a")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestImages_ServesAPrivateAttachmentWithTheTokenKeptServerSide(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var auth string
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auth = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge)

	resp := getImage(t, srv, cookie, "forgejo", forge.URL+"/attachments/uuid")
	defer func() { _ = resp.Body.Close() }()
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, imagesPNG, got)
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, "token "+imagesToken, auth, "the forge is asked with the saved token")
	for name, values := range resp.Header {
		for _, v := range values {
			assert.NotContains(t, v, imagesToken, "header %s leaks the token", name)
		}
	}
}

func TestImages_AnswersWithHeadersThatKeepTheBytesInert(t *testing.T) {
	t.Parallel()
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Set-Cookie", "sid=abc")
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge)

	resp := getImage(t, srv, cookie, "forgejo", forge.URL+"/a")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, "image/png", resp.Header.Get("Content-Type"), "the sniffed type, not the host's word")
	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	assert.Equal(t, "default-src 'none'; sandbox", resp.Header.Get("Content-Security-Policy"))
	assert.Equal(t, "private, max-age=3600", resp.Header.Get("Cache-Control"))
	assert.Empty(t, resp.Header.Get("Set-Cookie"), "nothing from the forge's response is passed on")
}

func TestImages_Refusals(t *testing.T) {
	t.Parallel()
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/missing":
			w.WriteHeader(http.StatusNotFound)
		case "/private":
			w.WriteHeader(http.StatusForbidden)
		case "/page":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("<html>not an image</html>"))
		}
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge)

	for name, tc := range map[string]struct {
		forge, url string
		want       int
	}{
		"another host on forgejo":        {"forgejo", "https://example.org/a.png", http.StatusForbidden},
		"another host on github":         {"github", "https://example.org/a.png", http.StatusForbidden},
		"a host that only looks like it": {"github", "https://github.com.evil.example/a.png", http.StatusForbidden},
		"a loopback address on github":   {"github", "https://127.0.0.1/a.png", http.StatusForbidden},
		"a metadata address on github":   {"github", "https://169.254.169.254/latest", http.StatusForbidden},
		"a relative address":             {"forgejo", "/attachments/a", http.StatusForbidden},
		"a missing image":                {"forgejo", forge.URL + "/missing", http.StatusNotFound},
		"an image the token cannot read": {"forgejo", forge.URL + "/private", http.StatusForbidden},
		"a page sent as an image":        {"forgejo", forge.URL + "/page", http.StatusUnsupportedMediaType},
		"an unknown forge":               {"gitlab", forge.URL + "/a", http.StatusBadRequest},
		"no address":                     {"forgejo", "", http.StatusBadRequest},
	} {
		resp := getImage(t, srv, cookie, tc.forge, tc.url)
		_ = resp.Body.Close()
		assert.Equal(t, tc.want, resp.StatusCode, name)
	}
}

func TestImages_ForgejoWithoutAnInstanceIsABadRequest(t *testing.T) {
	t.Parallel()
	testSrv, _, _, _ := newTestServerWithSettingsStore(t, func(settingspkg.Credentials) []dashboard.Source { return nil }, false, 0)
	cookie, _, _ := registerViaRealCeremony(t, testSrv)

	resp := getImage(t, testSrv.URL, cookie, "forgejo", "https://git.example/a.png")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// fakeLinkResolver is a GitHub source that can turn an attachment link into
// the signed address its rendered HTML carries.
type fakeLinkResolver struct {
	dashboard.Source
	signed string
	err    error

	mu    sync.Mutex
	owner string
	name  string
	item  dashboard.ImageItem
	link  string
}

func (f *fakeLinkResolver) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (f *fakeLinkResolver) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
}

func (f *fakeLinkResolver) SignedImageURL(_ context.Context, owner, name string, item dashboard.ImageItem, link string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.owner, f.name, f.item, f.link = owner, name, item, link

	return f.signed, f.err
}

const privateAttachment = "https://github.com/user-attachments/assets/1b2c3d4e-0000-4000-8000-000000000001"

// githubImagesServer serves a GitHub account whose image hosts is the test
// server host, over plain http, so a signed address can be fetched locally.
func githubImagesServer(t *testing.T, host *httptest.Server, src dashboard.Source) (string, *http.Cookie) {
	t.Helper()
	u, err := url.Parse(host.URL)
	require.NoError(t, err)
	proxy := imageproxy.New(imageproxy.Config{Hosts: []string{u.Host}, Scheme: "http", AllowLocal: true})
	testSrv, _, _, _ := newTestServerWithSettingsStore(t,
		func(settingspkg.Credentials) []dashboard.Source { return []dashboard.Source{src} }, false, 0,
		func(d *api.Deps) { d.GitHubImageProxy = proxy })
	cookie, _, _ := registerViaRealCeremony(t, testSrv)

	return testSrv.URL, cookie
}

func getItemImage(t *testing.T, srv string, cookie *http.Cookie, extra url.Values) *http.Response {
	t.Helper()
	q := url.Values{"forge": {"github"}, "url": {privateAttachment}}
	maps.Copy(q, extra)
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func TestImages_ShowsAPrivateGitHubImageThroughItsSignedAddressWithoutTheToken(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var auth string
	var path string
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auth, path = r.Header.Get("Authorization"), r.URL.RequestURI()
		mu.Unlock()
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(host.Close)
	src := &fakeLinkResolver{signed: host.URL + "/1/signed.png?jwt=abc"}
	srv, cookie := githubImagesServer(t, host, src)

	resp := getItemImage(t, srv, cookie, url.Values{"fullName": {"octo/repo"}, "number": {"7"}})
	defer func() { _ = resp.Body.Close() }()
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, imagesPNG, got)
	src.mu.Lock()
	defer src.mu.Unlock()
	assert.Equal(t, "octo", src.owner)
	assert.Equal(t, "repo", src.name)
	assert.Equal(t, dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}, src.item)
	assert.Equal(t, privateAttachment, src.link)
	mu.Lock()
	defer mu.Unlock()
	assert.Empty(t, auth, "the user-content host never sees the GitHub token")
	assert.Equal(t, "/1/signed.png?jwt=abc", path)
}

func TestImages_ResolvesAReleaseImageByItsTag(t *testing.T) {
	t.Parallel()
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(host.Close)
	src := &fakeLinkResolver{signed: host.URL + "/s.png"}
	srv, cookie := githubImagesServer(t, host, src)

	resp := getItemImage(t, srv, cookie, url.Values{"fullName": {"octo/repo"}, "tag": {"v1.2.0"}})
	_ = resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	src.mu.Lock()
	defer src.mu.Unlock()
	assert.Equal(t, dashboard.ImageItem{Kind: dashboard.ImageItemRelease, Tag: "v1.2.0"}, src.item)
}

func TestImages_RefusesASignedAddressOutsideGitHubsHosts(t *testing.T) {
	t.Parallel()
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(host.Close)
	src := &fakeLinkResolver{signed: "https://example.org/s.png"}
	srv, cookie := githubImagesServer(t, host, src)

	resp := getItemImage(t, srv, cookie, url.Values{"fullName": {"octo/repo"}, "number": {"7"}})
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestImages_DoesNotLookUpAnItemForAnImageThatIsNotAnAttachment(t *testing.T) {
	t.Parallel()
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(host.Close)
	src := &fakeLinkResolver{signed: "unused"}
	srv, cookie := githubImagesServer(t, host, src)

	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+url.Values{
		"forge": {"github"}, "url": {host.URL + "/plain.png"}, "fullName": {"octo/repo"}, "number": {"7"},
	}.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	src.mu.Lock()
	defer src.mu.Unlock()
	assert.Empty(t, src.link, "no API request is spent on an address that isn't a user attachment")
}

func TestImages_FallsBackToTheAttachmentLinkWhenTheItemCannotBeRead(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var hits int
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(host.Close)
	src := &fakeLinkResolver{err: errors.New("boom")}
	srv, cookie := githubImagesServer(t, host, src)

	resp := getItemImage(t, srv, cookie, url.Values{"fullName": {"octo/repo"}, "number": {"7"}})
	_ = resp.Body.Close()

	// The link itself is on github.com, outside the test proxy's host list.
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	mu.Lock()
	defer mu.Unlock()
	assert.Zero(t, hits)
}
