package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokensGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/tokens")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestTokensGet_NoneYet_ReturnsEmptyArrayNotNull(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/tokens", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body []api.Token
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Empty(t, body)
}

func TestTokensPost_ThenGet_ListsItWithoutTheRawValue(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(`{"label":"laptop"}`))
	require.NoError(t, err)
	postReq.AddCookie(sessionCookie)
	postReq.Header.Set("Content-Type", "application/json")
	postResp, err := http.DefaultClient.Do(postReq)
	require.NoError(t, err)
	defer func() { _ = postResp.Body.Close() }()

	require.Equal(t, http.StatusCreated, postResp.StatusCode)
	var created struct {
		ID        string `json:"id"`
		Label     string `json:"label"`
		Token     string `json:"token"`
		CreatedAt string `json:"createdAt"`
	}
	require.NoError(t, json.NewDecoder(postResp.Body).Decode(&created))
	assert.Equal(t, "laptop", created.Label)
	assert.NotEmpty(t, created.Token)
	assert.True(t, strings.HasPrefix(created.Token, "fdb_"))

	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/tokens", nil)
	require.NoError(t, err)
	getReq.AddCookie(sessionCookie)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	require.Equal(t, http.StatusOK, getResp.StatusCode)
	body := readAll(t, getResp)
	// The raw token is never in the list response — only in the one
	// create response that already closed above.
	assert.NotContains(t, body, created.Token)
	var listed []api.Token
	require.NoError(t, json.Unmarshal([]byte(body), &listed))
	require.Len(t, listed, 1)
	assert.Equal(t, created.ID, listed[0].ID)
	assert.Nil(t, listed[0].LastUsedAt)
}

func TestTokensPost_BlankLabel_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(`{"label":"   "}`))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestTokenCreated_AuthenticatesAsBearerAgainstARealEndpoint(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(`{"label":"ci script"}`))
	require.NoError(t, err)
	postReq.AddCookie(sessionCookie)
	postReq.Header.Set("Content-Type", "application/json")
	postResp, err := http.DefaultClient.Do(postReq)
	require.NoError(t, err)
	defer func() { _ = postResp.Body.Close() }()
	var created struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(postResp.Body).Decode(&created))

	// GET /api/tokens itself, with no session cookie at all — the real
	// point of this feature: a script authenticating the same way a
	// signed-in browser does.
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/tokens", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+created.Token)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestTokensDelete_StopsItAuthenticating(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(`{"label":"laptop"}`))
	require.NoError(t, err)
	postReq.AddCookie(sessionCookie)
	postReq.Header.Set("Content-Type", "application/json")
	postResp, err := http.DefaultClient.Do(postReq)
	require.NoError(t, err)
	defer func() { _ = postResp.Body.Close() }()
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(postResp.Body).Decode(&created))

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/tokens/"+created.ID, nil)
	require.NoError(t, err)
	delReq.AddCookie(sessionCookie)
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	defer func() { _ = delResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, delResp.StatusCode)

	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/tokens", nil)
	require.NoError(t, err)
	getReq.Header.Set("Authorization", "Bearer "+created.Token)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, getResp.StatusCode)
}

func TestTokensDelete_UnknownID_StillReturns204(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/tokens/not-a-real-id", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}
