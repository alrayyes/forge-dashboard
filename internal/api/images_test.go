package api_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	githubpkg "github.com/alrayyes/forge-dashboard/internal/github"
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
func imagesServer(t *testing.T, forge *httptest.Server, opts ...func(*api.Deps)) (srv string, cookie *http.Cookie) {
	t.Helper()
	testSrv, _, _, _ := newTestServerWithSettingsStore(t, func(settingspkg.Credentials) []dashboard.Source { return nil }, false, 0, opts...)
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

// realLinkSource is a GitHub source whose image-link lookup is the real
// client's, pointed at a local API server.
type realLinkSource struct {
	dashboard.Source
	client *githubpkg.Client
}

func (*realLinkSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (*realLinkSource) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
}

func (r *realLinkSource) SignedImageURL(ctx context.Context, owner, name string, item dashboard.ImageItem, link string) (string, error) {
	return r.client.SignedImageURL(ctx, owner, name, item, link) //nolint:wrapcheck // a test double
}

const githubToken = "github-token-for-images"

// githubImages is a GitHub account with two local servers standing in for the
// API host and the user-content host. The first sees the saved token; the
// second must never.
type githubImages struct {
	srv    string
	cookie *http.Cookie
	// link is an attachment address on the image host, as written in Markdown.
	link string

	mu        sync.Mutex
	apiPaths  []string
	apiAuth   []string
	imagePath []string
	imageAuth []string
}

func (g *githubImages) apiCalls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()

	return append([]string(nil), g.apiPaths...)
}

func (g *githubImages) imageCalls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()

	return append([]string(nil), g.imagePath...)
}

// newGitHubImages starts both servers. signed is the src the rendered body
// holds for the attachment; apiStatus, when not zero, makes the API fail.
func newGitHubImages(t *testing.T, signedPath string, apiStatus int, failImage map[string]bool) *githubImages {
	t.Helper()
	g := &githubImages{}
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.imagePath = append(g.imagePath, r.URL.RequestURI())
		g.imageAuth = append(g.imageAuth, r.Header.Get("Authorization"))
		g.mu.Unlock()
		if failImage[r.URL.Path] {
			w.WriteHeader(http.StatusNotFound)

			return
		}
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(images.Close)
	g.link = images.URL + "/user-attachments/assets/1b2c3d4e"

	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.apiPaths = append(g.apiPaths, r.URL.Path)
		g.apiAuth = append(g.apiAuth, r.Header.Get("Authorization"))
		g.mu.Unlock()
		if apiStatus != 0 {
			w.WriteHeader(apiStatus)

			return
		}
		w.Header().Set("Content-Type", "application/json")
		src := signedPath
		if strings.HasPrefix(src, "/") {
			src = images.URL + src
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"body_html": `<a href="` + g.link + `"><img src="` + src + `"></a>`,
		})
	}))
	t.Cleanup(apiSrv.Close)

	u, err := url.Parse(images.URL)
	require.NoError(t, err)
	proxy := imageproxy.New(imageproxy.Config{Hosts: []string{u.Host}, Scheme: "http", AllowLocal: true})
	source := &realLinkSource{client: githubpkg.NewClient(githubToken, "", apiSrv.URL)}
	testSrv, _, _, _ := newTestServerWithSettingsStore(t,
		func(settingspkg.Credentials) []dashboard.Source { return []dashboard.Source{source} }, false, 0,
		func(d *api.Deps) {
			d.GitHubImageProxy = proxy
			d.GitHubImageOrigin = images.URL
		})
	g.srv = testSrv.URL
	g.cookie, _, _ = registerViaRealCeremony(t, testSrv)

	return g
}

func (g *githubImages) get(t *testing.T, extra url.Values) *http.Response {
	t.Helper()
	q := url.Values{"forge": {"github"}, "url": {g.link}}
	maps.Copy(q, extra)
	req, err := http.NewRequest(http.MethodGet, g.srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(g.cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func (g *githubImages) status(t *testing.T, extra url.Values) int {
	t.Helper()
	resp := g.get(t, extra)
	_ = resp.Body.Close()

	return resp.StatusCode
}

var issue7 = url.Values{"fullName": {"octo/repo"}, "number": {"7"}}

func TestImages_ShowsAPrivateGitHubImageThroughItsSignedAddressWithoutTheToken(t *testing.T) {
	t.Parallel()
	g := newGitHubImages(t, "/1/signed.png?jwt=abc", 0, nil)

	resp := g.get(t, issue7)
	defer func() { _ = resp.Body.Close() }()
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, imagesPNG, got)
	assert.Equal(t, []string{"/repos/octo/repo/issues/7"}, g.apiCalls())
	assert.Equal(t, []string{"Bearer " + githubToken}, g.apiAuth, "the API host gets the saved token")
	assert.Equal(t, []string{"/1/signed.png?jwt=abc"}, g.imageCalls(), "only the signed address is fetched")
	assert.Equal(t, []string{""}, g.imageAuth, "the user-content host never sees the token")
}

func TestImages_ResolvesAReleaseImageByItsTag(t *testing.T) {
	t.Parallel()
	g := newGitHubImages(t, "/s.png", 0, nil)

	status := g.status(t, url.Values{"fullName": {"octo/repo"}, "tag": {"v1.2.0"}})

	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"/repos/octo/repo/releases/tags/v1.2.0"}, g.apiCalls())
}

func TestImages_ATagWinsOverANumber(t *testing.T) {
	t.Parallel()
	g := newGitHubImages(t, "/s.png", 0, nil)

	status := g.status(t, url.Values{"fullName": {"octo/repo"}, "tag": {"v1"}, "number": {"7"}})

	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"/repos/octo/repo/releases/tags/v1"}, g.apiCalls())
}

func TestImages_FallsBackToTheOriginalLinkWhenTheSignedAddressCannotBeUsed(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		signed     string
		apiStatus  int
		failImages map[string]bool
	}{
		"a signed address on a host that isn't allowed": {signed: "https://example.org/s.png"},
		"a signed address that fails to load":           {signed: "/s.png", failImages: map[string]bool{"/s.png": true}},
		"an item that can't be read":                    {signed: "/s.png", apiStatus: http.StatusInternalServerError},
	} {
		g := newGitHubImages(t, tc.signed, tc.apiStatus, tc.failImages)

		status := g.status(t, issue7)

		assert.Equal(t, http.StatusOK, status, name)
		calls := g.imageCalls()
		require.NotEmpty(t, calls, name)
		assert.Equal(t, "/user-attachments/assets/1b2c3d4e", calls[len(calls)-1], "%s: the original link was fetched", name)
		assert.Len(t, g.apiCalls(), 1, name)
	}
}

func TestImages_DoesNotLookUpTheItemWhenTheRequestCannotNameOne(t *testing.T) {
	t.Parallel()
	for name, extra := range map[string]url.Values{
		"no item":             {},
		"a bad full name":     {"fullName": {"nope"}, "number": {"7"}},
		"a number of zero":    {"fullName": {"octo/repo"}, "number": {"0"}},
		"a negative number":   {"fullName": {"octo/repo"}, "number": {"-3"}},
		"a number that isn't": {"fullName": {"octo/repo"}, "number": {"abc"}},
		"an empty tag":        {"fullName": {"octo/repo"}, "tag": {""}},
		"a dot tag":           {"fullName": {"octo/repo"}, "tag": {"."}},
		"a dot-dot tag":       {"fullName": {"octo/repo"}, "tag": {".."}},
		"a tag with a slash":  {"fullName": {"octo/repo"}, "tag": {"a/b"}},
	} {
		g := newGitHubImages(t, "/s.png", 0, nil)

		status := g.status(t, extra)

		assert.Equal(t, http.StatusOK, status, name)
		assert.Empty(t, g.apiCalls(), name)
		assert.Equal(t, []string{"/user-attachments/assets/1b2c3d4e"}, g.imageCalls(), name)
	}
}

func TestImages_DoesNotLookUpAnItemForAnImageThatIsNotAnAttachment(t *testing.T) {
	t.Parallel()
	g := newGitHubImages(t, "/s.png", 0, nil)
	before, _, _ := strings.Cut(g.link, "/user-attachments")
	extra := url.Values{"url": {before + "/plain.png"}}
	maps.Copy(extra, issue7)

	status := g.status(t, extra)

	require.Equal(t, http.StatusOK, status)
	assert.Empty(t, g.apiCalls(), "no API request is spent on an address that isn't a user attachment")
}

// pngOf pads the one-pixel PNG to n bytes. The proxy sniffs the leading bytes
// only, so the padding still reads as a PNG.
func pngOf(n int) []byte {
	return append(append([]byte{}, imagesPNG...), make([]byte, n-len(imagesPNG))...)
}

func getAvatar(t *testing.T, srv string, cookie *http.Cookie, raw string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {"forgejo"}, "url": {raw}, "kind": {"avatar"}}
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

// avatarStatus is safe to call off the test goroutine: it asserts nothing.
func avatarStatus(tb testing.TB, srv string, cookie *http.Cookie, raw string) int {
	tb.Helper()
	q := url.Values{"forge": {"forgejo"}, "url": {raw}, "kind": {"avatar"}}
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	if err != nil {
		return 0
	}
	req.AddCookie(cookie)
	resp, err := testClient(tb).Do(req)
	if err != nil {
		return 0
	}
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode
}

func TestImages_AnAvatarHasASmallerSizeCapThanAnEmbeddedImage(t *testing.T) {
	t.Parallel()
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(pngOf(imageproxy.MaxAvatarBytes + 1))
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge)

	avatar := getAvatar(t, srv, cookie, forge.URL+"/avatar")
	defer func() { _ = avatar.Body.Close() }()
	embedded := getImage(t, srv, cookie, "forgejo", forge.URL+"/embedded")
	defer func() { _ = embedded.Body.Close() }()

	assert.Equal(t, http.StatusRequestEntityTooLarge, avatar.StatusCode)
	assert.Equal(t, http.StatusOK, embedded.StatusCode, "the same bytes pass as an embedded image")
}

func TestImages_ServesARepeatedRequestFromTheServerSideCache(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	hits := map[string]int{}
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge)

	for range 3 {
		resp := getAvatar(t, srv, cookie, forge.URL+"/a")
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, imagesPNG, body)
	}
	resp := getAvatar(t, srv, cookie, forge.URL+"/b")
	_ = resp.Body.Close()

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, 1, hits["/a"], "one upstream fetch for three requests")
	assert.Equal(t, 1, hits["/b"], "a different image is its own fetch")
}

func TestImages_DoesNotServeACachedImageAfterItsTimeIsUp(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var hits int
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge, func(d *api.Deps) { d.ImageCacheTTL = 20 * time.Millisecond })

	for range 2 {
		resp := getAvatar(t, srv, cookie, forge.URL+"/a")
		_ = resp.Body.Close()
		time.Sleep(60 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, 2, hits)
}

// blockingForge answers every image request only once release is closed, and
// reports the most requests it held at the same moment.
type blockingForge struct {
	*httptest.Server
	release chan struct{}
	mu      sync.Mutex
	current int
	peak    int
}

func newBlockingForge(t *testing.T) *blockingForge {
	t.Helper()
	b := &blockingForge{release: make(chan struct{})}
	b.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		b.current++
		b.peak = max(b.peak, b.current)
		b.mu.Unlock()
		select {
		case <-b.release:
		case <-r.Context().Done():
		}
		b.mu.Lock()
		b.current--
		b.mu.Unlock()
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(b.Close)

	return b
}

func (b *blockingForge) peakSeen() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.peak
}

func TestImages_BoundsHowManyUpstreamFetchesRunAtOnce(t *testing.T) {
	t.Parallel()
	const limit, requests = 2, 6
	forge := newBlockingForge(t)
	srv, cookie := imagesServer(t, forge.Server, func(d *api.Deps) {
		d.ImageConcurrency = limit
		d.ImageQueueWait = 10 * time.Second
	})

	var wg sync.WaitGroup
	codes := make([]int, requests)
	for i := range requests {
		wg.Go(func() { codes[i] = avatarStatus(t, srv, cookie, forge.URL+"/img"+strconv.Itoa(i)) })
	}
	require.Eventually(t, func() bool { return forge.peakSeen() == limit }, 5*time.Second, 10*time.Millisecond)
	time.Sleep(100 * time.Millisecond) // room for an unbounded proxy to overshoot
	assert.Equal(t, limit, forge.peakSeen(), "no more than the limit are in flight")
	close(forge.release)
	wg.Wait()

	assert.LessOrEqual(t, forge.peakSeen(), limit)
	for _, c := range codes {
		assert.Equal(t, http.StatusOK, c, "the waiting requests are served in turn")
	}
}

func TestImages_RefusesWithRetryAfterWhenTheQueueWaitRunsOut(t *testing.T) {
	t.Parallel()
	forge := newBlockingForge(t)
	srv, cookie := imagesServer(t, forge.Server, func(d *api.Deps) {
		d.ImageConcurrency = 1
		d.ImageQueueWait = 50 * time.Millisecond
	})
	first := make(chan int, 1)
	go func() { first <- avatarStatus(t, srv, cookie, forge.URL+"/first") }()
	require.Eventually(t, func() bool { return forge.peakSeen() == 1 }, 5*time.Second, 10*time.Millisecond)

	resp := getAvatar(t, srv, cookie, forge.URL+"/second")
	defer func() { _ = resp.Body.Close() }()
	close(forge.release)
	<-first

	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	assert.NotEmpty(t, resp.Header.Get("Retry-After"))
}
