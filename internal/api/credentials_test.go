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
	beginResp, err := testClient(t).Do(beginReq)
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
	finishResp, err := testClient(t).Do(finishReq)
	require.NoError(t, err)

	authenticator.AddCredential(cred)

	return finishResp
}

func TestCredentialsGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := testClient(t).Get(srv.URL + "/api/auth/credentials")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCredentialsGet_AfterRegistration_ListsTheInitialPasskey(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
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
	sessionCookie, firstCred, firstAuthenticator := registerViaRealCeremony(t, srv)

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
	listResp, err := testClient(t).Do(listReq)
	require.NoError(t, err)
	defer func() { _ = listResp.Body.Close() }()
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&creds))
	require.Len(t, creds, 2)

	// The original passkey (from registration) still logs in.
	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	beginResp, err := testClient(t).Post(srv.URL+"/api/auth/login/begin", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = beginResp.Body.Close() }()
	require.Equal(t, http.StatusOK, beginResp.StatusCode)
	optionsJSON, err := io.ReadAll(beginResp.Body)
	require.NoError(t, err)
	assertionOptions, err := virtualwebauthn.ParseAssertionOptions(string(optionsJSON))
	require.NoError(t, err)
	assertionResponse := virtualwebauthn.CreateAssertionResponse(rp, firstAuthenticator, firstCred, *assertionOptions)
	loginResp, err := testClient(t).Post(srv.URL+"/api/auth/login/finish", "application/json", strings.NewReader(assertionResponse))
	require.NoError(t, err)
	defer func() { _ = loginResp.Body.Close() }()
	assert.Equal(t, http.StatusOK, loginResp.StatusCode, "login/finish body: %s", readAll(t, loginResp))
}

func TestAddCredential_BlankLabel_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/credentials/begin", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
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
	finishResp, err := testClient(t).Do(finishReq)
	require.NoError(t, err)
	defer func() { _ = finishResp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, finishResp.StatusCode)
}

func TestCredentialsDelete_WithAnotherRemaining_RemovesIt(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	finishResp := addCredentialViaRealCeremony(t, srv, sessionCookie, "YubiKey")
	require.Equal(t, http.StatusCreated, finishResp.StatusCode)
	var created api.CredentialInfo
	require.NoError(t, json.NewDecoder(finishResp.Body).Decode(&created))
	_ = finishResp.Body.Close()

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/auth/credentials/"+created.ID, nil)
	require.NoError(t, err)
	delReq.AddCookie(sessionCookie)
	delResp, err := testClient(t).Do(delReq)
	require.NoError(t, err)
	defer func() { _ = delResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, delResp.StatusCode)

	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	listReq.AddCookie(sessionCookie)
	listResp, err := testClient(t).Do(listReq)
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
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	listReq.AddCookie(sessionCookie)
	listResp, err := testClient(t).Do(listReq)
	require.NoError(t, err)
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&creds))
	_ = listResp.Body.Close()
	require.Len(t, creds, 1)

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/auth/credentials/"+creds[0].ID, nil)
	require.NoError(t, err)
	delReq.AddCookie(sessionCookie)
	delResp, err := testClient(t).Do(delReq)
	require.NoError(t, err)
	defer func() { _ = delResp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, delResp.StatusCode)

	// The credential really does survive the refused delete — still logs in.
	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	getReq.AddCookie(sessionCookie)
	getResp, err := testClient(t).Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()
	var stillThere []api.CredentialInfo
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&stillThere))
	assert.Len(t, stillThere, 1)
}

func TestCredentialsDelete_UnknownID_StillReturns204(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/auth/credentials/not-a-real-id", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

// renameCredential PATCHes a passkey's label with a raw JSON body.
func renameCredential(t *testing.T, srv *httptest.Server, sessionCookie *http.Cookie, id, body string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(http.MethodPatch, srv.URL+"/api/auth/credentials/"+id, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func listCredentialsAs(t *testing.T, srv *httptest.Server, sessionCookie *http.Cookie) []api.CredentialInfo {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/credentials", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var creds []api.CredentialInfo
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&creds))

	return creds
}

func TestCredentialsRename_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp := renameCredential(t, srv, nil, "anything", `{"label":"x"}`)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCredentialsRename_SavesTheTrimmedNameAndListsIt(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	before := listCredentialsAs(t, srv, sessionCookie)
	require.Len(t, before, 1)

	resp := renameCredential(t, srv, sessionCookie, before[0].ID, `{"label":"  Proton Pass  "}`)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var got api.CredentialInfo
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	assert.Equal(t, "Proton Pass", got.Label)
	assert.Equal(t, before[0].ID, got.ID)
	after := listCredentialsAs(t, srv, sessionCookie)
	require.Len(t, after, 1)
	assert.Equal(t, "Proton Pass", after[0].Label)
	assert.True(t, before[0].CreatedAt.Equal(after[0].CreatedAt))
}

func TestCredentialsRename_StoresMarkupAsPlainText(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	before := listCredentialsAs(t, srv, sessionCookie)

	resp := renameCredential(t, srv, sessionCookie, before[0].ID, `{"label":"<b>key</b>"}`)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "<b>key</b>", listCredentialsAs(t, srv, sessionCookie)[0].Label)
}

func TestCredentialsRename_RefusedNames_Return400NamingTheField(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"blank":            `{"label":"   "}`,
		"empty":            `{"label":""}`,
		"missing":          `{}`,
		"over the limit":   `{"label":"` + strings.Repeat("a", 65) + `"}`,
		"over in runes":    `{"label":"` + strings.Repeat("é", 65) + `"}`,
		"not json":         `nope`,
		"label not string": `{"label":5}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv := newTestServer(t)
			sessionCookie, _, _ := registerViaRealCeremony(t, srv)
			before := listCredentialsAs(t, srv, sessionCookie)

			resp := renameCredential(t, srv, sessionCookie, before[0].ID, body)
			defer func() { _ = resp.Body.Close() }()

			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			if name != "not json" && name != "label not string" {
				var e map[string]string
				require.NoError(t, json.NewDecoder(resp.Body).Decode(&e))
				assert.Equal(t, "label", e["field"])
				assert.NotEmpty(t, e["error"])
			}
			assert.Equal(t, before[0].Label, listCredentialsAs(t, srv, sessionCookie)[0].Label)
		})
	}
}

func TestCredentialsRename_ExactlyAtTheLimit_IsAccepted(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	before := listCredentialsAs(t, srv, sessionCookie)

	resp := renameCredential(t, srv, sessionCookie, before[0].ID, `{"label":"`+strings.Repeat("é", 64)+`"}`)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestCredentialsRename_UnknownID_Returns404(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	resp := renameCredential(t, srv, sessionCookie, "not-a-real-id", `{"label":"Mine"}`)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}
