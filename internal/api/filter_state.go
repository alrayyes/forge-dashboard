package api

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// maxFilterStateBytes caps the request body PUT /api/settings/filter-state
// accepts — filter state is a handful of short strings (#353), generous
// headroom over anything filters.js could ever actually produce, just
// enough to refuse an obviously abusive body outright rather than
// storing it.
const maxFilterStateBytes = 16 * 1024

// handleFilterStateGet answers with the signed-in user's own saved
// filter state verbatim — this handler never parses or re-encodes it,
// the same "opaque blob" treatment settings.Store.GetFilterState itself
// gives it, so a client-side shape change here never needs a matching
// server change.
func handleFilterStateGet(store *settings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		state, err := store.GetFilterState(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load filter state"))

			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, state)
	}
}

// handleFilterStatePut stores the request body verbatim as the signed-in
// user's new filter state — validated only as well-formed JSON, never
// interpreted, so filters.js's own shape can evolve without a matching
// change here.
func handleFilterStatePut(store *settings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFilterStateBytes))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("request body too large"))

			return
		}
		if !json.Valid(body) {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}

		if err := store.SetFilterState(r.Context(), u.ID, string(body)); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save filter state"))

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
