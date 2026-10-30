package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// maxFilterStateBytes caps the request body PUT /api/v1/settings/filter-state
// accepts — filter state is a handful of short strings (#353), generous
// headroom over anything the frontend filter bar could ever actually produce, just
// enough to refuse an obviously abusive body outright rather than
// storing it.
const maxFilterStateBytes = 16 * 1024

// The Label, Repo and Author filters' picks are saved as lowercase values
// joined by a newline, in a cookie as well as here, so each is held to a size
// a cookie carries, and to text with no control character that could split one
// value into two.
const (
	maxPickValues = 20
	maxPickChars  = 1000
)

// pickKeys are the shared filters saved as several values joined by a newline:
// label, repo and author. Each is held to the same limits.
var pickKeys = []string{"label", "repo", "author"}

// invalidPick names the first of shared.label, shared.repo and shared.author
// in a filter state body that is there and a string but is outside those
// limits, or returns "" when all are inside them. Everything else about the
// body stays opaque.
func invalidPick(body []byte) string {
	var state struct {
		Shared map[string]any `json:"shared"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		// Some other shape under "shared": not this check's concern.
		return ""
	}

	for _, key := range pickKeys {
		if pick, ok := state.Shared[key].(string); ok && !validPick(pick) {
			return key
		}
	}

	return ""
}

func validPick(pick string) bool {
	if utf8.RuneCountInString(pick) > maxPickChars {
		return false
	}

	if strings.Count(pick, "\n")+1 > maxPickValues {
		return false
	}

	for _, r := range pick {
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
		state, err := store.GetFilterState(r.Context())
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
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFilterStateBytes))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("request body too large"))

			return
		}
		if !json.Valid(body) {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}

		if key := invalidPick(body); key != "" {
			writeJSON(w, http.StatusBadRequest, errorBody(`the "`+key+`" filter pick is too long or invalid`))

			return
		}

		if err := store.SetFilterState(r.Context(), string(body)); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save filter state"))

			return
		}

		// Says which client wrote the filters, so a surprise change can be
		// traced (#1000). RequireSession means it is always a browser session.
		slog.Info("filter state saved", "via", "session", "user_agent", r.UserAgent(), "bytes", len(body))

		w.WriteHeader(http.StatusNoContent)
	}
}
