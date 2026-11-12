package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

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
	item := dashboard.ImageItem{Kind: dashboard.ImageItemIssue, Number: 7}

	first, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)
	second, err := client.SignedImageURL(t.Context(), "octo", "repo", item, attachment)
	require.NoError(t, err)

	assert.Contains(t, first, "jwt1")
	assert.Contains(t, second, "jwt2")
}
