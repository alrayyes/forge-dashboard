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

func TestAdminListUsers_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/admin/users")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAdminListUsers_NonAdmin_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/users", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestAdminListUsers_Admin_ListsEveryUser(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/users", nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var users []api.AdminUser
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&users))
	require.Len(t, users, 2)

	byUsername := map[string]api.AdminUser{}
	for _, u := range users {
		byUsername[u.Username] = u
	}
	assert.True(t, byUsername[testAdmin].IsAdmin)
	assert.False(t, byUsername[testUser].IsAdmin)
}

func TestAdminRevokeUser_NonAdmin_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/admin/users/anyone/revoke", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestAdminRevokeUser_Admin_SignsTheTargetOutEverywhere(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	targetCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/admin/users/"+testUser+"/revoke", nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	req2, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req2.AddCookie(targetCookie)
	resp2, err := http.DefaultClient.Do(req2)
	require.NoError(t, err)
	defer func() { _ = resp2.Body.Close() }()
	assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode, "the revoked user's old session should no longer work")
}

func TestAdminRevokeUser_UnknownUsername_NotFound(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/admin/users/nobody-registered/revoke", nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestAdminRevokeUser_OwnAccount_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/admin/users/"+testAdmin+"/revoke", nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestAdminDeleteUser_NonAdmin_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/admin/users/anyone", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestAdminDeleteUser_Admin_RemovesTheAccountEntirely(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/admin/users/"+testUser, nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/users", nil)
	require.NoError(t, err)
	listReq.AddCookie(adminCookie)
	listResp, err := http.DefaultClient.Do(listReq)
	require.NoError(t, err)
	defer func() { _ = listResp.Body.Close() }()

	var users []api.AdminUser
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&users))
	require.Len(t, users, 1, "the deleted user should no longer be listed")
	assert.Equal(t, testAdmin, users[0].Username)
}

func TestAdminDeleteUser_DeletedUsernameCanRegisterAgain(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	registerViaRealCeremony(t, srv, testUser, testDisplay)

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/admin/users/"+testUser, nil)
	require.NoError(t, err)
	delReq.AddCookie(adminCookie)
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	_ = delResp.Body.Close()
	require.Equal(t, http.StatusNoContent, delResp.StatusCode)

	resp, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`","displayName":"Someone New"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestAdminDeleteUser_OwnAccount_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/admin/users/"+testAdmin, nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
