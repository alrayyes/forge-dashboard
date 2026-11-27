package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (f *setupFixture) verify(t *testing.T, instance string) (int, map[string]any) {
	t.Helper()

	resp := doJSON(t, http.MethodPost, f.gh.srv.URL+"/api/v1/setup/forgejo-instance", `{"instanceUrl":"`+instance+`"}`, f.gh.cookie)
	defer func() { _ = resp.Body.Close() }()

	var body map[string]any
	require.NoError(t, readJSON(resp, &body))

	return resp.StatusCode, body
}

func TestSetupVerifyInstance_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp := doJSON(t, http.MethodPost, srv.URL+"/api/v1/setup/forgejo-instance", `{"instanceUrl":"https://git.example"}`, nil)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestSetupVerifyInstance_AForgejoAnswers_ReturnsItsAddress(t *testing.T) {
	t.Parallel()

	f := newSetupFixture(t, "")
	status, body := f.verify(t, f.fj.forge.server.URL+"/")

	require.Equal(t, http.StatusOK, status, "%v", body)
	assert.Equal(t, f.fj.forge.server.URL, body["instanceUrl"])
}

func TestSetupVerifyInstance_NothingListening_NamesTheAddressField(t *testing.T) {
	t.Parallel()

	// Port 1 refuses. A closed test server's port can be taken by a parallel
	// test's server, which would then answer (#5129).
	status, body := newSetupFixture(t, "").verify(t, "http://127.0.0.1:1")

	t.Run("is a 400", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, http.StatusBadRequest, status)
	})

	t.Run("names instanceUrl", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "instanceUrl", body["field"])
	})
}

func TestSetupVerifyInstance_ASiteThatIsNotForgejo_Is400(t *testing.T) {
	t.Parallel()

	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>hello</html>"))
	}))
	t.Cleanup(other.Close)

	status, body := newSetupFixture(t, "").verify(t, other.URL)

	t.Run("is a 400", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, http.StatusBadRequest, status)
	})

	t.Run("names instanceUrl", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "instanceUrl", body["field"])
	})
}

func TestSetupVerifyInstance_UserinfoOrAQuery_Is400WithoutAsking(t *testing.T) {
	t.Parallel()

	for name, withIt := range map[string]func(host string) string{
		"a password": func(host string) string { return "http://user:pw@" + host },
		"a query":    func(host string) string { return "http://" + host + "/?next=/x" },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			var asked atomic.Int32

			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				asked.Add(1)
				_, _ = w.Write([]byte(`{"version":"11.0.0"}`))
			}))
			t.Cleanup(srv.Close)

			status, body := newSetupFixture(t, "").verify(t, withIt(strings.TrimPrefix(srv.URL, "http://")))

			require.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, "instanceUrl", body["field"])
			assert.Zero(t, asked.Load(), "the address is refused before anything is asked of it")
		})
	}
}

func TestSetupVerifyInstance_NotAnHTTPAddress_Is400WithoutAsking(t *testing.T) {
	t.Parallel()

	status, body := newSetupFixture(t, "").verify(t, "ftp://git.example")

	t.Run("is a 400", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, http.StatusBadRequest, status)
	})

	t.Run("names instanceUrl", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "instanceUrl", body["field"])
	})
}
