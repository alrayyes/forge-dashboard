package api

import (
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
)

// tagKind marks every forge request the handler makes as kind, for the
// forge-API counters.
func tagKind(kind apistats.Kind, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(apistats.WithKind(r.Context(), kind)))
	})
}
