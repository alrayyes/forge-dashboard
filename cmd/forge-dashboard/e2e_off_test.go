//go:build !e2e

package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
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
