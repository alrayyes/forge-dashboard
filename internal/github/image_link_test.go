package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const attachment = "https://github.com/user-attachments/assets/1b2c3d4e-0000-4000-8000-000000000001"

const renderedBody = `<p dir="auto">Before</p>
<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://github.com/user-attachments/assets/other"><img src="https://private-user-images.githubusercontent.com/9/other.png?jwt=zzz" alt="other"></a></p>
<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="` + attachment + `"><img width="10" src="https://private-user-images.githubusercontent.com/1/signed.png?jwt=abc&amp;x=1" alt="shot" style="max-width: 100%;"></a></p>`

func imageLinkClient(t *testing.T, path string, seen *http.Request) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = *r
		}
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestSignedImageURL_ReadsTheRenderedIssueBody(t *testing.T) {
	t.Parallel()
	var seen http.Request
	client := imageLinkClient(t, "/repos/octo/repo/issues/7", &seen)

	got, err := client.SignedImageURL(t.Context(), "octo", "repo",
		dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}, attachment)

	require.NoError(t, err)
	assert.Equal(t, "https://private-user-images.githubusercontent.com/1/signed.png?jwt=abc&x=1", got)
	assert.Equal(t, "application/vnd.github.full+json", seen.Header.Get("Accept"))
	assert.Equal(t, "Bearer test-token", seen.Header.Get("Authorization"))
}

func TestSignedImageURL_ReadsTheRenderedReleaseBody(t *testing.T) {
	t.Parallel()
	client := imageLinkClient(t, "/repos/octo/repo/releases/tags/v1.2.0", nil)

	got, err := client.SignedImageURL(t.Context(), "octo", "repo",
		dashboard.ImageItem{Kind: dashboard.ImageItemRelease, Tag: "v1.2.0"}, attachment)

	require.NoError(t, err)
	assert.Contains(t, got, "signed.png")
}

func TestSignedImageURL_ReadsTheRenderedCommentBody(t *testing.T) {
	t.Parallel()
	var seen http.Request
	client := imageLinkClient(t, "/repos/octo/repo/issues/comments/4242", &seen)

	got, err := client.SignedImageURL(t.Context(), "octo", "repo",
		dashboard.ImageItem{Kind: dashboard.ImageItemComment, CommentID: 4242}, attachment)

	require.NoError(t, err)
	assert.Equal(t, "https://private-user-images.githubusercontent.com/1/signed.png?jwt=abc&x=1", got)
	assert.Equal(t, "application/vnd.github.full+json", seen.Header.Get("Accept"))
	assert.Equal(t, "Bearer test-token", seen.Header.Get("Authorization"))
}

func TestSignedImageURL_ACommentIsKeptApartFromAnIssueOfTheSameNumber(t *testing.T) {
	t.Parallel()
	var hits atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/octo/repo/", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := github.NewClient("test-token", "", srv.URL)
	client.ShareRenderedBodyCache(github.NewRenderedBodyCache())

	_, err := client.SignedImageURL(t.Context(), "octo", "repo", dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}, attachment)
	require.NoError(t, err)
	_, err = client.SignedImageURL(t.Context(), "octo", "repo", dashboard.ImageItem{Kind: dashboard.ImageItemComment, CommentID: 7}, attachment)
	require.NoError(t, err)

	assert.EqualValues(t, 2, hits.Load(), "issue 7 and comment 7 are two bodies")
}

func TestSignedImageURL_AnswersEmptyWhenTheItemDoesNotEmbedTheLink(t *testing.T) {
	t.Parallel()
	client := imageLinkClient(t, "/repos/octo/repo/issues/7", nil)

	got, err := client.SignedImageURL(t.Context(), "octo", "repo",
		dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7},
		"https://github.com/user-attachments/assets/missing")

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestSignedImageURL_NeverReplaysAnExpiredSignatureFromTheETagCache(t *testing.T) {
	t.Parallel()
	now := time.Now()
	var calls int
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/octo/repo/issues/7", func(w http.ResponseWriter, r *http.Request) {
		calls++
		assert.Empty(t, r.Header.Get("If-None-Match"), "a signed address is never revalidated")
		w.Header().Set("ETag", `"same"`)
		jwt := fmt.Sprintf("jwt%d", calls)
		writeJSON(t, w, map[string]any{"body_html": `<a href="` + attachment + `"><img src="https://private-user-images.githubusercontent.com/1/s.png?jwt=` + jwt + `"></a>`})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := github.NewClient("test-token", "", srv.URL)
	client.SetRenderedBodyClockForTest(func() time.Time { return now })
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	first, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)
	now = now.Add(time.Hour)
	second, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)

	assert.Contains(t, first, "jwt1")
	assert.Contains(t, second, "jwt2")
}

func countingClient(t *testing.T, calls *atomic.Int32) *github.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/octo/repo/issues/7", func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestSignedImageURL_TwoImagesInOneItemCostOneRequest(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	client := countingClient(t, &calls)
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	first, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)
	other, err := client.SignedImageURL(t.Context(), "octo", "repo", item, "https://github.com/user-attachments/assets/other")
	require.NoError(t, err)

	assert.Contains(t, first, "signed.png")
	assert.Contains(t, other, "other.png")
	assert.EqualValues(t, 1, calls.Load())
}

func TestSignedImageURL_ConcurrentImagesShareOneRequest(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	client := countingClient(t, &calls)
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	var wg sync.WaitGroup
	for range 5 {
		wg.Go(func() {
			_, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
			assert.NoError(t, err)
		})
	}
	wg.Wait()

	assert.EqualValues(t, 1, calls.Load())
}

func TestSignedImageURL_NeverServesTheBodyPastItsLifetime(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	client := countingClient(t, &calls)
	now := time.Now()
	client.SetRenderedBodyClockForTest(func() time.Time { return now })
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	_, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)
	now = now.Add(time.Minute)
	_, err = client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)
	assert.EqualValues(t, 1, calls.Load(), "still fresh a minute on")

	now = now.Add(time.Minute + time.Second)
	_, err = client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)
	assert.EqualValues(t, 2, calls.Load(), "read again once the lifetime is up")
}

func TestSignedImageURL_KeepsItemsApart(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/octo/repo/issues/", func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := github.NewClient("test-token", "", srv.URL)

	for _, n := range []int{7, 8} {
		_, err := client.SignedImageURL(t.Context(), "octo", "repo",
			dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: n}, attachment)
		require.NoError(t, err)
	}

	assert.EqualValues(t, 2, calls.Load())
}

func TestSignedImageURL_TwoCredentialsNeverShareAnEntry(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		who := r.Header.Get("Authorization")
		writeJSON(t, w, map[string]any{"body_html": `<a href="` + attachment + `"><img src="https://private-user-images.githubusercontent.com/1/` + url.QueryEscape(who) + `.png"></a>`})
	}))
	t.Cleanup(srv.Close)
	cache := github.NewRenderedBodyCache()
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}
	resolve := func(token string) string {
		c := github.NewClient(token, "", srv.URL)
		c.ShareRenderedBodyCache(cache)
		got, err := c.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
		require.NoError(t, err)

		return got
	}

	a := resolve("token-a")
	b := resolve("token-b")
	again := resolve("token-a")

	assert.Contains(t, a, "token-a")
	assert.Contains(t, b, "token-b", "one account's body is never served to another")
	assert.Equal(t, a, again)
	assert.EqualValues(t, 2, calls.Load())
}

func TestSignedImageURL_AFailedReadIsNotCached(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)

			return
		}
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	}))
	t.Cleanup(srv.Close)
	client := github.NewClient("test-token", "", srv.URL)
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	_, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.Error(t, err)
	got, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)

	require.NoError(t, err)
	assert.Contains(t, got, "signed.png")
	assert.EqualValues(t, 2, calls.Load())
}

func TestSignedImageURL_TheCacheHoldsAtMostItsCap(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	}))
	t.Cleanup(srv.Close)
	client := github.NewClient("test-token", "", srv.URL)
	client.SetRenderedBodyMaxForTest(2)
	now := time.Now()
	client.SetRenderedBodyClockForTest(func() time.Time { return now })
	read := func(n int) {
		now = now.Add(time.Second)
		_, err := client.SignedImageURL(t.Context(), "octo", "repo", dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: n}, attachment)
		require.NoError(t, err)
	}

	read(1)
	read(2)
	read(3) // evicts item 1, the first to expire
	assert.EqualValues(t, 3, calls.Load())
	read(2)
	read(3)
	assert.EqualValues(t, 3, calls.Load(), "the newest two are kept")
	read(1)
	assert.EqualValues(t, 4, calls.Load(), "the evicted one is read again")
	assert.LessOrEqual(t, client.RenderedBodyCountForTest(), 2)
}

func TestSignedImageURL_AClientWithNoIdentityCachesNothing(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/app/installations/1/access_tokens", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"token": "installation-token", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/repos/octo/repo/issues/7", func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeJSON(t, w, map[string]any{"body_html": renderedBody})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// An App client no one gave a stats label to has nothing telling it from
	// another installation, so a shared cache must not hold its entries.
	client, err := github.NewAppClient(1, 1, testAppPrivateKeyPEM, srv.URL)
	require.NoError(t, err)
	client.ShareRenderedBodyCache(github.NewRenderedBodyCache())
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	for range 2 {
		_, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
		require.NoError(t, err)
	}

	assert.EqualValues(t, 2, calls.Load())
}
