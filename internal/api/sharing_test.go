package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testOtherUser = "alex"

func TestSharingGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/sharing")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestSharingGet_NothingSharedYet_ReturnsEmptyArraysNotNull(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/sharing", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body api.SharingResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Empty(t, body.SharedWith)
	assert.Empty(t, body.SharedWithMe)
}

func TestSharingPut_ThenGet_ListsTheSharedUser(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	registerViaRealCeremony(t, srv, testOtherUser, "Alex")

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/sharing/"+testOtherUser, nil)
	require.NoError(t, err)
	putReq.AddCookie(ownerCookie)
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/sharing", nil)
	require.NoError(t, err)
	getReq.AddCookie(ownerCookie)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	var body api.SharingResponse
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&body))
	require.Len(t, body.SharedWith, 1)
	assert.Equal(t, testOtherUser, body.SharedWith[0].Username)
}

func TestSharingPut_TheOtherUserSeesItInSharedWithMe(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	viewerCookie, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex")

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/sharing/"+testOtherUser, nil)
	require.NoError(t, err)
	putReq.AddCookie(ownerCookie)
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/sharing", nil)
	require.NoError(t, err)
	getReq.AddCookie(viewerCookie)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	var body api.SharingResponse
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&body))
	require.Len(t, body.SharedWithMe, 1)
	assert.Equal(t, testUser, body.SharedWithMe[0].Username)
}

func TestSharingPut_WithSelf_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/sharing/"+testUser, nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestSharingPut_UnknownUsername_NotFound(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/sharing/nobody-registered", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestSharingDelete_RemovesTheShare(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	registerViaRealCeremony(t, srv, testOtherUser, "Alex")

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/sharing/"+testOtherUser, nil)
	require.NoError(t, err)
	putReq.AddCookie(ownerCookie)
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	delReq, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/sharing/"+testOtherUser, nil)
	require.NoError(t, err)
	delReq.AddCookie(ownerCookie)
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	defer func() { _ = delResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, delResp.StatusCode)

	getReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/sharing", nil)
	require.NoError(t, err)
	getReq.AddCookie(ownerCookie)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer func() { _ = getResp.Body.Close() }()

	var body api.SharingResponse
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&body))
	assert.Empty(t, body.SharedWith)
}
