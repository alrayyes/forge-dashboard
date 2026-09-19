package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/descope/virtualwebauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// addCredentialViaRealCeremony drives POST /api/auth/credentials/begin
// and /finish through the actual HTTP handlers with a fresh virtual
// authenticator — a real second device (a security key alongside the
// laptop registerViaRealCeremony already set up), not a mock of
// forge-dashboard's own code.
func addCredentialViaRealCeremony(t *testing.T, srv *httptest.Server, sessionCookie *http.Cookie, label string) *http.Response {
	t.Helper()

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	beginReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/credentials/begin", nil)
	require.NoError(t, err)
	beginReq.AddCookie(sessionCookie)
	beginResp, err := http.DefaultClient.Do(beginReq)
	require.NoError(t, err)
	defer func() { _ = beginResp.Body.Close() }()
	require.Equal(t, http.StatusOK, beginResp.StatusCode)

	optionsJSON, err := io.ReadAll(beginResp.Body)
	require.NoError(t, err)

	attestationOptions, err := virtualwebauthn.ParseAttestationOptions(string(optionsJSON))
	require.NoError(t, err)
	require.NotNil(t, attestationOptions)

	attestationResponse := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *attestationOptions)

	finishReq, err := http.NewRequest(
		http.MethodPost,
		srv.URL+"/api/auth/credentials/finish?label="+label,
		strings.NewReader(attestationResponse),
	)
	require.NoError(t, err)
	finishReq.AddCookie(sessionCookie)
	finishReq.Header.Set("Content-Type", "application/json")
	finishResp, err := http.DefaultClient.Do(finishReq)
	require.NoError(t, err)

	authenticator.AddCredential(cred)

	return finishResp
}

func TestCredentialsGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/auth/credentials")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCredentialsGet_AfterRegistration_ListsTheInitialPasskey(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&creds))
	require.Len(t, creds, 1)
	assert.NotEmpty(t, creds[0].Label)
	assert.False(t, creds[0].CreatedAt.IsZero())
}

func TestAddCredential_SecondPasskey_BothAuthenticateAfterwards(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, firstCred, firstAuthenticator := registerViaRealCeremony(t, srv, testUser, testDisplay)

	finishResp := addCredentialViaRealCeremony(t, srv, sessionCookie, "YubiKey")
	finishBody := readAll(t, finishResp)
	_ = finishResp.Body.Close()
	require.Equal(t, http.StatusCreated, finishResp.StatusCode, "finish body: %s", finishBody)
	var created api.CredentialInfo
	require.NoError(t, json.NewDecoder(strings.NewReader(finishBody)).Decode(&created))
	assert.Equal(t, "YubiKey", created.Label)

	// Both credentials are now listed.
	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	listReq.AddCookie(sessionCookie)
	listResp, err := http.DefaultClient.Do(listReq)
	require.NoError(t, err)
	defer func() { _ = listResp.Body.Close() }()
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&creds))
	require.Len(t, creds, 2)

	// The original passkey (from registration) still logs in.
	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	beginResp, err := http.Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`"}`))
	require.NoError(t, err)
	defer func() { _ = beginResp.Body.Close() }()
	require.Equal(t, http.StatusOK, beginResp.StatusCode)
	optionsJSON, err := io.ReadAll(beginResp.Body)
	require.NoError(t, err)
	assertionOptions, err := virtualwebauthn.ParseAssertionOptions(string(optionsJSON))
	require.NoError(t, err)
	assertionResponse := virtualwebauthn.CreateAssertionResponse(rp, firstAuthenticator, firstCred, *assertionOptions)
	loginResp, err := http.Post(srv.URL+"/api/auth/login/finish?username="+testUser, "application/json", strings.NewReader(assertionResponse))
	require.NoError(t, err)
	defer func() { _ = loginResp.Body.Close() }()
	assert.Equal(t, http.StatusOK, loginResp.StatusCode, "login/finish body: %s", readAll(t, loginResp))
}

func TestAddCredential_BlankLabel_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/credentials/begin", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	optionsJSON, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	attestationOptions, err := virtualwebauthn.ParseAttestationOptions(string(optionsJSON))
	require.NoError(t, err)
	attestationResponse := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *attestationOptions)

	finishReq, err := http.NewRequest(
		http.MethodPost,
		srv.URL+"/api/auth/credentials/finish?label=",
		strings.NewReader(attestationResponse),
	)
	require.NoError(t, err)
	finishReq.AddCookie(sessionCookie)
	finishResp, err := http.DefaultClient.Do(finishReq)
	require.NoError(t, err)
	defer func() { _ = finishResp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, finishResp.StatusCode)
}

func TestCredentialsDelete_WithAnotherRemaining_RemovesIt(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	finishResp := addCredentialViaRealCeremony(t, srv, sessionCookie, "YubiKey")
	require.Equal(t, http.StatusCreated, finishResp.StatusCode)
	var created api.CredentialInfo
	require.NoError(t, json.NewDecoder(finishResp.Body).Decode(&created))
	_ = finishResp.Body.Close()

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/auth/credentials/"+created.ID, nil)
	require.NoError(t, err)
	delReq.AddCookie(sessionCookie)
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	defer func() { _ = delResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, delResp.StatusCode)

	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	listReq.AddCookie(sessionCookie)
	listResp, err := http.DefaultClient.Do(listReq)
	require.NoError(t, err)
	defer func() { _ = listResp.Body.Close() }()
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&creds))
	require.Len(t, creds, 1)
}

// TestCredentialsDelete_LastOne_Returns400 is #355's core safety
// property, exercised through the real HTTP handler.
func TestCredentialsDelete_LastOne_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	listReq.AddCookie(sessionCookie)
	listResp, err := http.DefaultClient.Do(listReq)
	require.NoError(t, err)
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&creds))
	_ = listResp.Body.Close()
	require.Len(t, creds, 1)

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/auth/credentials/"+creds[0].ID, nil)
	require.NoError(t, err)
	delReq.AddCookie(sessionCookie)
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	defer func() { _ = delResp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, delResp.StatusCode)

	// The credential really does survive the refused delete — still logs in.
	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	getReq.AddCookie(sessionCookie)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()
	var stillThere []api.CredentialInfo
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&stillThere))
	assert.Len(t, stillThere, 1)
}

func TestCredentialsDelete_UnknownID_StillReturns204(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/auth/credentials/not-a-real-id", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}
