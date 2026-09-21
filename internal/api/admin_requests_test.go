package api_test

import (
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAdminListRequests_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/admin/requests")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAdminListRequests_NonAdmin_Refused(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServerWithStore(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	token := createInviteViaAdmin(t, srv, adminCookie, testUser, testDisplay)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay, token)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestAdminExportRequests_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/admin/requests/export")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAdminExportRequests_NonAdmin_Refused(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServerWithStore(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	token := createInviteViaAdmin(t, srv, adminCookie, testUser, testDisplay)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay, token)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests/export", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

// seedRequestLog inserts a GitHub and a Forgejo row directly into store
// — there's no HTTP endpoint to create one through, since a real entry
// only ever comes from a forge client's own outbound call.
func seedRequestLog(t *testing.T, store *auth.Store, githubAccountID string) {
	t.Helper()

	limit, remaining := 5000, 4999
	resetsAt := time.Now().UTC().Truncate(time.Second)
	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt:           time.Now().UTC(),
		Forge:              "github",
		AccountID:          githubAccountID,
		Method:             http.MethodPost,
		Endpoint:           "/graphql",
		StatusCode:         200,
		Outcome:            "success",
		RateLimitLimit:     &limit,
		RateLimitRemaining: &remaining,
		RateLimitResetsAt:  &resetsAt,
	}, 10000))
	require.NoError(t, store.RecordRequest(t.Context(), auth.RequestLogRow{
		LoggedAt:   time.Now().UTC(),
		Forge:      "forgejo",
		Method:     http.MethodGet,
		Endpoint:   "/repos/alrayyes/forge-dashboard/pulls",
		StatusCode: 200,
		Outcome:    "success",
	}, 10000))
}

func TestAdminListRequests_Admin_ListsEveryEntry(t *testing.T) {
	t.Parallel()

	srv, store := newTestServerWithStore(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	admin, err := store.GetUserByUsername(t.Context(), testAdmin)
	require.NoError(t, err)
	seedRequestLog(t, store, base64.RawURLEncoding.EncodeToString(admin.ID))

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests", nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var entries []api.AdminRequestLogEntry
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&entries))
	require.Len(t, entries, 2)

	byForge := map[string]api.AdminRequestLogEntry{}
	for _, e := range entries {
		byForge[e.Forge] = e
	}
	require.Contains(t, byForge, "github")
	assert.Equal(t, testAdmin, byForge["github"].Account, "the account id should resolve to its current username")
	require.NotNil(t, byForge["github"].RateLimit)
	assert.Equal(t, 5000, byForge["github"].RateLimit.Limit)
	require.Contains(t, byForge, "forgejo")
	assert.Empty(t, byForge["forgejo"].Account, "a request made with no per-account credential has no account to resolve")
}

func TestAdminListRequests_FilterByForge_Narrows(t *testing.T) {
	t.Parallel()

	srv, store := newTestServerWithStore(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	admin, err := store.GetUserByUsername(t.Context(), testAdmin)
	require.NoError(t, err)
	seedRequestLog(t, store, base64.RawURLEncoding.EncodeToString(admin.ID))

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests?forge=forgejo", nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var entries []api.AdminRequestLogEntry
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&entries))
	require.Len(t, entries, 1)
	assert.Equal(t, "forgejo", entries[0].Forge)
}

func TestAdminListRequests_FilterByAccount_Narrows(t *testing.T) {
	t.Parallel()

	srv, store := newTestServerWithStore(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	admin, err := store.GetUserByUsername(t.Context(), testAdmin)
	require.NoError(t, err)
	accountID := base64.RawURLEncoding.EncodeToString(admin.ID)
	seedRequestLog(t, store, accountID)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests?account="+accountID, nil)
	require.NoError(t, err)
	req.AddCookie(adminCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var entries []api.AdminRequestLogEntry
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&entries))
	require.Len(t, entries, 1)
	assert.Equal(t, testAdmin, entries[0].Account)
}

// TestAdminExportRequests_CSVRoundTripsSameFilteredRowsAsList is the
// spec's own acceptance criterion: the downloaded CSV contains exactly
// the entries matching a filter, with the same data GET /api/admin/
// requests would return for that same filter.
func TestAdminExportRequests_CSVRoundTripsSameFilteredRowsAsList(t *testing.T) {
	t.Parallel()

	srv, store := newTestServerWithStore(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	admin, err := store.GetUserByUsername(t.Context(), testAdmin)
	require.NoError(t, err)
	seedRequestLog(t, store, base64.RawURLEncoding.EncodeToString(admin.ID))

	listReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests?forge=github", nil)
	require.NoError(t, err)
	listReq.AddCookie(adminCookie)
	listResp, err := http.DefaultClient.Do(listReq)
	require.NoError(t, err)
	defer func() { _ = listResp.Body.Close() }()
	require.Equal(t, http.StatusOK, listResp.StatusCode)
	var entries []api.AdminRequestLogEntry
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&entries))
	require.Len(t, entries, 1)

	exportReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/admin/requests/export?forge=github", nil)
	require.NoError(t, err)
	exportReq.AddCookie(adminCookie)
	exportResp, err := http.DefaultClient.Do(exportReq)
	require.NoError(t, err)
	defer func() { _ = exportResp.Body.Close() }()
	require.Equal(t, http.StatusOK, exportResp.StatusCode)
	assert.Equal(t, "text/csv", exportResp.Header.Get("Content-Type"))
	assert.Contains(t, exportResp.Header.Get("Content-Disposition"), "attachment")

	rows, err := csv.NewReader(exportResp.Body).ReadAll()
	require.NoError(t, err)
	require.Len(t, rows, 2, "one header row plus one data row")
	assert.Equal(t, []string{
		"loggedAt", "forge", "account", "method", "endpoint", "statusCode", "outcome",
		"rateLimitLimit", "rateLimitRemaining", "rateLimitResetsAt", "rateLimitCost",
	}, rows[0])

	want := entries[0]
	got := rows[1]
	assert.Equal(t, want.LoggedAt, got[0])
	assert.Equal(t, want.Forge, got[1])
	assert.Equal(t, want.Account, got[2])
	assert.Equal(t, want.Method, got[3])
	assert.Equal(t, want.Endpoint, got[4])
	assert.Equal(t, "200", got[5])
	assert.Equal(t, want.Outcome, got[6])
	require.NotNil(t, want.RateLimit)
	assert.Equal(t, "5000", got[7])
	assert.Equal(t, "4999", got[8])
}
