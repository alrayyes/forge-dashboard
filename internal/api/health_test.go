package api_test

import (
	"net/http"
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
