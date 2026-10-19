//go:build !e2e

package main

import (
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/api"
)

// withE2EHooks is a no-op outside an e2e build: a release binary carries no
// route that can wipe its database.
func withE2EHooks(next http.Handler, _ api.Deps) http.Handler { return next }
