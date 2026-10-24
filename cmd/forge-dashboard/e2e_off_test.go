//go:build !e2e

package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The e2e reset route deletes everything a test left behind, so a release
// binary must not carry it: only a build with -tags e2e mounts it.
func TestWithE2EHooks_DefaultBuildAddsNoRoutes(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	handler := withE2EHooks(next, api.Deps{})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/__e2e/reset", nil))

	assert.Equal(t, http.StatusTeapot, rec.Code, "the request reaches the normal handler, which knows no such route")
}

// The sign-in limit is what keeps a stranger from flooding the ceremony store,
// so a release binary must build its limiter. This runs in the default test
// configuration, where the build tag selects the release-side constant.
func TestAuthLimit_ReleaseBuildEnablesTheLimiter(t *testing.T) {
	t.Parallel()

	limiter, _, err := resolveAuthLimit("", authLimitEnabled)

	require.NoError(t, err)
	assert.NotNil(t, limiter, "a release build without a limiter ships with no sign-in limit")
}
