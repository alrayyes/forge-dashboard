package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// validExpiresAt is 30 days out — Settings' own pre-selected default
// (#356) — for tests whose point is something other than the expiry
// validation itself.
func validExpiresAt() string {
	return time.Now().Add(30 * 24 * time.Hour).Format(time.RFC3339)
}

func tokenCreateBody(label string) string {
	return fmt.Sprintf(`{"label":%q,"expiresAt":%q}`, label, validExpiresAt())
}

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

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(tokenCreateBody("laptop")))
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

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(tokenCreateBody("   ")))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// TestTokensPost_ReturnsExpiresAt is #356's own acceptance criterion
// that the create response carries the expiration, not just label/id.
func TestTokensPost_ReturnsExpiresAt(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	wantExpiresAt := time.Now().Add(60 * 24 * time.Hour)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens",
		strings.NewReader(fmt.Sprintf(`{"label":"laptop","expiresAt":%q}`, wantExpiresAt.Format(time.RFC3339))))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var created struct {
		ExpiresAt time.Time `json:"expiresAt"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&created))
	assert.WithinDuration(t, wantExpiresAt, created.ExpiresAt, time.Second)
}

func TestTokensGet_ListsExpiresAtPerToken(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(tokenCreateBody("laptop")))
	require.NoError(t, err)
	postReq.AddCookie(sessionCookie)
	postReq.Header.Set("Content-Type", "application/json")
	postResp, err := http.DefaultClient.Do(postReq)
	require.NoError(t, err)
	_ = postResp.Body.Close()
	require.Equal(t, http.StatusCreated, postResp.StatusCode)

	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/tokens", nil)
	require.NoError(t, err)
	getReq.AddCookie(sessionCookie)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	var listed []api.Token
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&listed))
	require.Len(t, listed, 1)
	assert.False(t, listed[0].ExpiresAt.IsZero())
}

func TestTokensPost_ExpiresAtInThePast_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	pastExpiry := time.Now().Add(-time.Hour).Format(time.RFC3339)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens",
		strings.NewReader(fmt.Sprintf(`{"label":"laptop","expiresAt":%q}`, pastExpiry)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestTokensPost_ExpiresAtMissing_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(`{"label":"laptop"}`))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "the zero time value is never in the future, so an omitted expiresAt is rejected the same as a past one")
}

// TestTokensPost_ExpiresAtBeyond366Days_Returns400 is #356's own cap —
// GitHub's fine-grained-token maximum, the reason there's no "never
// expires" option: the cap alone rules that out.
func TestTokensPost_ExpiresAtBeyond366Days_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	tooFar := time.Now().Add(367 * 24 * time.Hour).Format(time.RFC3339)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens",
		strings.NewReader(fmt.Sprintf(`{"label":"laptop","expiresAt":%q}`, tooFar)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestTokensPost_ExpiresAtExactly366Days_IsAllowed(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	// A hair under the exact boundary, not on it — the request takes a
	// few milliseconds to reach the handler, which computes its own
	// "now" independently; an expiresAt set from precisely
	// time.Now().Add(366 days) here can land a few milliseconds earlier
	// than the handler's own now.Add(366 days), tripping the "more than
	// 366 days out" check by that same sliver and making this test flaky
	// on a slow CI runner. A minute of margin has no such race.
	almost366Days := time.Now().Add(366*24*time.Hour - time.Minute).Format(time.RFC3339)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens",
		strings.NewReader(fmt.Sprintf(`{"label":"laptop","expiresAt":%q}`, almost366Days)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusCreated, resp.StatusCode)
}

func TestTokenExpired_RejectedLikeAnInvalidToken(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	// The handler itself refuses a past expiresAt at creation time, so
	// this drives the real expiry check the only way that's actually
	// reachable through the API: a token that expires very soon, used
	// again just after it does.
	soonExpiry := time.Now().Add(200 * time.Millisecond).Format(time.RFC3339)

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens",
		strings.NewReader(fmt.Sprintf(`{"label":"laptop","expiresAt":%q}`, soonExpiry)))
	require.NoError(t, err)
	postReq.AddCookie(sessionCookie)
	postReq.Header.Set("Content-Type", "application/json")
	postResp, err := http.DefaultClient.Do(postReq)
	require.NoError(t, err)
	var created struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(postResp.Body).Decode(&created))
	_ = postResp.Body.Close()

	require.Eventually(t, func() bool {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/tokens", nil)
		if err != nil {
			return false
		}
		req.Header.Set("Authorization", "Bearer "+created.Token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer func() { _ = resp.Body.Close() }()

		return resp.StatusCode == http.StatusUnauthorized
	}, time.Second, 20*time.Millisecond, "an expired token should stop authenticating once its expiresAt passes")
}

func TestTokenCreated_AuthenticatesAsBearerAgainstARealEndpoint(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(tokenCreateBody("ci script")))
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

	postReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tokens", strings.NewReader(tokenCreateBody("laptop")))
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
