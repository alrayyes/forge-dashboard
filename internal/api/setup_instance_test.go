package api_test

import (
	"net/http"
	"net/http/httptest"
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

	dead := httptest.NewServer(http.NotFoundHandler())
	addr := dead.URL
	dead.Close()

	status, body := newSetupFixture(t, "").verify(t, addr)

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
