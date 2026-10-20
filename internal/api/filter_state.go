package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// maxFilterStateBytes caps the request body PUT /api/settings/filter-state
// accepts — filter state is a handful of short strings (#353), generous
// headroom over anything the frontend filter bar could ever actually produce, just
// enough to refuse an obviously abusive body outright rather than
// storing it.
const maxFilterStateBytes = 16 * 1024

// The Label filter's pick is saved as lowercase labels joined by a newline, in
// a cookie as well as here, so it is held to a size a cookie carries, and to
// text with no control character that could split one label into two.
const (
	maxLabelPickLabels = 20
	maxLabelPickChars  = 1000
)

// validLabelPick reports whether shared.label in a filter state body, when it
// is there and a string, stays inside those limits. Everything else about the
// body stays opaque.
func validLabelPick(body []byte) bool {
	var state struct {
		Shared struct {
			Label any `json:"label"`
		} `json:"shared"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		// Some other shape under "shared": not this check's concern.
		return true
	}

	label, ok := state.Shared.Label.(string)
	if !ok {
		return true
	}

	if utf8.RuneCountInString(label) > maxLabelPickChars {
		return false
	}

	if strings.Count(label, "\n")+1 > maxLabelPickLabels {
		return false
	}

	for _, r := range label {
		if r != '\n' && unicode.IsControl(r) {
			return false
		}
	}

	return true
}

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
// user's new filter state — validated only as well-formed JSON and the label pick's limits, never
// interpreted, so the frontend's own filter shape can evolve without a matching
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

		if !validLabelPick(body) {
			writeJSON(w, http.StatusBadRequest, errorBody("label filter too long or invalid"))

			return
		}

		if err := store.SetFilterState(r.Context(), u.ID, string(body)); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save filter state"))

			return
		}

		// Says which client wrote the filters, so a surprise change can be
		// traced (#1000). RequireSession means it is always a browser session.
		slog.Info("filter state saved", "via", "session", "user_agent", r.UserAgent(), "bytes", len(body))

		w.WriteHeader(http.StatusNoContent)
	}
}
