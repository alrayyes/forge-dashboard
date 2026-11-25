package oauth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const versionBody = `{"version":"11.0.0"}`

func serve(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	return srv
}

func TestCheckForgejoInstance_AForgejoAnswers_ReturnsTheAddressWithoutASlash(t *testing.T) {
	t.Parallel()

	srv := serve(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(versionBody)) })

	got, err := oauth.CheckForgejoInstance(t.Context(), srv.URL+"/")

	require.NoError(t, err)
	assert.Equal(t, srv.URL, got)
}

func TestCheckForgejoInstance_ARedirectIsNotFollowed(t *testing.T) {
	t.Parallel()

	for _, code := range []int{http.StatusFound, http.StatusTemporaryRedirect} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			t.Parallel()

			var elsewhere atomic.Int32

			target := serve(t, func(w http.ResponseWriter, _ *http.Request) {
				elsewhere.Add(1)
				_, _ = w.Write([]byte(versionBody))
			})
			srv := serve(t, func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, target.URL+"/api/v1/version", code)
			})

			_, err := oauth.CheckForgejoInstance(t.Context(), srv.URL)

			require.ErrorIs(t, err, oauth.ErrNotForgejo)
			assert.Zero(t, elsewhere.Load(), "the redirect target must never be asked")
		})
	}
}

func TestCheckForgejoInstance_ABodyOverTheCap_IsRefused(t *testing.T) {
	t.Parallel()

	// Valid JSON that only turns up its version after more than 4 KiB.
	padded := `{"pad":"` + strings.Repeat("x", 8<<10) + `","version":"11.0.0"}`
	srv := serve(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(padded)) })

	_, err := oauth.CheckForgejoInstance(t.Context(), srv.URL)

	assert.ErrorIs(t, err, oauth.ErrNotForgejo)
}

func TestCheckForgejoInstance_ASlowServer_GivesUpWhenTheContextEnds(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	srv := serve(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) })

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := oauth.CheckForgejoInstance(ctx, srv.URL)

	t.Run("fails as not a Forgejo", func(t *testing.T) {
		t.Parallel()
		assert.ErrorIs(t, err, oauth.ErrNotForgejo)
	})

	t.Run("does not wait for the server", func(t *testing.T) {
		t.Parallel()
		assert.Less(t, time.Since(start), 5*time.Second)
	})
}

func TestCheckForgejoInstance_NothingTheInstanceSaysIsEchoedInTheError(t *testing.T) {
	t.Parallel()

	const secret = "s3cret-from-the-instance"

	for name, h := range map[string]http.HandlerFunc{
		"an error page": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(secret))
		},
		"a body that is not JSON": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(secret)) },
		"JSON with no version": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"message":"` + secret + `"}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			_, err := oauth.CheckForgejoInstance(t.Context(), serve(t, h).URL)

			require.Error(t, err)
			assert.NotContains(t, err.Error(), secret)
		})
	}
}
