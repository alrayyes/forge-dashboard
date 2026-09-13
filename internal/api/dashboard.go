package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// handleDashboard answers the requested dashboard: the signed-in user's
// own by default, or another user's — passed as ?owner=username — when
// that user has shared their dashboard with the caller. It never blocks
// on either forge: Manager.Get reads whatever that user's background
// refresh last assembled — empty, not an error, for a user who hasn't
// saved any credentials in Settings yet.
func handleDashboard(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			// RequireAuth always sets this before handleDashboard runs;
			// reaching here with none would be a wiring bug, not a
			// request this handler can meaningfully answer.
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		ownerUsername := r.URL.Query().Get("owner")
		if ownerUsername == "" || ownerUsername == u.Username {
			writeJSON(w, http.StatusOK, deps.Manager.Get(u.ID))
			return
		}

		owner, err := deps.AuthStore.GetUserByUsername(r.Context(), ownerUsername)
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("no user is registered under that username"))
				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not look up owner"))
			return
		}

		shared, err := deps.SharingStore.IsSharedWith(r.Context(), owner.ID, u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not check sharing"))
			return
		}
		if !shared {
			writeJSON(w, http.StatusForbidden, errorBody("that user hasn't shared their dashboard with you"))
			return
		}

		writeJSON(w, http.StatusOK, deps.Manager.Get(owner.ID))
	}
}

// handleDashboardStream pushes the signed-in user's own dashboard
// snapshot over Server-Sent Events every time their Aggregator produces
// a new one — most notably right after a verified webhook delivery
// triggers Manager.RefreshNow, which is what turns that into a live
// update instead of something only the next scheduled refresh picks up.
//
// Unlike handleDashboard, there's no ?owner= — only ever the signed-in
// user's own dashboard. The frontend's own poll against GET
// /api/dashboard keeps running unconditionally, connected or not: a
// browser or proxy that can't hold this connection open just never
// benefits from it, rather than the dashboard going stale silently.
func handleDashboardStream(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("streaming not supported"))
			return
		}

		ch, unsubscribe, ok := deps.Manager.Subscribe(u.ID)
		if !ok {
			// No Aggregator running yet (Settings has never been saved) —
			// a plain 404 rather than an open connection with nothing to
			// send. EventSource retries a failed connection on its own,
			// so the browser picks the stream up once one exists.
			writeJSON(w, http.StatusNotFound, errorBody("no background refresh is running yet for this user"))
			return
		}
		defer unsubscribe()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		for {
			select {
			case <-r.Context().Done():
				return
			case snap, open := <-ch:
				if !open {
					return
				}
				data, err := json.Marshal(snap)
				if err != nil {
					return
				}
				if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}
