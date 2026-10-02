package api_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVersion_NoSessionNeeded_AnswersTheRunningVersion(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/version")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got api.Version
	require.NoError(t, readJSON(resp, &got))
	assert.Equal(t, testVersion, got.Version)
}

type fakeDB struct{ err error }

func (f fakeDB) PingContext(context.Context) error { return f.err }

type fakeRefresh struct{ done bool }

func (f fakeRefresh) FirstRefreshComplete() bool { return f.done }

func readyzServer(t *testing.T, db api.DatabasePinger, refresh api.FirstRefreshGate) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(api.NewMux(api.Deps{Version: testVersion, Database: db, Dashboard: refresh}))
	t.Cleanup(srv.Close)

	return srv
}

func getBody(t *testing.T, url string) (int, string) {
	t.Helper()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return resp.StatusCode, string(b)
}

func TestReadyz_DatabaseUpAndFirstRefreshDone_Answers200(t *testing.T) {
	t.Parallel()

	srv := readyzServer(t, fakeDB{}, fakeRefresh{done: true})

	code, body := getBody(t, srv.URL+"/readyz")

	assert.Equal(t, http.StatusOK, code)
	assert.JSONEq(t, `{"status":"ok"}`, body)
}

func TestReadyz_FirstRefreshPending_Answers503WithShortReason_HealthzStays200(t *testing.T) {
	t.Parallel()

	srv := readyzServer(t, fakeDB{}, fakeRefresh{done: false})

	code, body := getBody(t, srv.URL+"/readyz")
	assert.Equal(t, http.StatusServiceUnavailable, code)
	assert.JSONEq(t, `{"error":"first dashboard refresh not complete"}`, body)

	code, _ = getBody(t, srv.URL+"/healthz")
	assert.Equal(t, http.StatusOK, code)
}

func TestReadyz_DatabaseFailing_Answers503WithoutLeakingTheDriverError(t *testing.T) {
	t.Parallel()

	srv := readyzServer(t, fakeDB{err: errors.New("unable to open /data/secret.db: disk I/O error")}, fakeRefresh{done: true})

	code, body := getBody(t, srv.URL+"/readyz")

	assert.Equal(t, http.StatusServiceUnavailable, code)
	assert.JSONEq(t, `{"error":"database unavailable"}`, body)
	assert.NotContains(t, body, "/data")

	code, _ = getBody(t, srv.URL+"/healthz")
	assert.Equal(t, http.StatusOK, code)
}

func TestReadyz_WithNoChecksWired_Answers200(t *testing.T) {
	t.Parallel()

	srv := readyzServer(t, nil, nil)

	code, _ := getBody(t, srv.URL+"/readyz")

	assert.Equal(t, http.StatusOK, code)
}
