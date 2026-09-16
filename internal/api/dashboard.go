package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
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
			warmUpAggregator(r.Context(), deps, u.ID, u.Username)
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

		warmUpAggregator(r.Context(), deps, owner.ID, owner.Username)
		writeJSON(w, http.StatusOK, deps.Manager.Get(owner.ID))
	}
}

// warmUpAggregator re-establishes userID's Aggregator from whatever they
// last saved in Settings, if the Manager doesn't already have one
// running for them. The Manager holds no state across a process restart
// — every deploy wipes it — and a request against an already-valid
// session cookie never goes through startSession's own warm-up again the
// way a fresh login does, so without this a dashboard that survived a
// restart would show the zero-value empty snapshot forever, not just
// until the next scheduled refresh. A user with nothing saved yet is a
// no-op, same as Manager.Get's empty-snapshot default.
//
// The Running() check is a fast path — cheap, and safe even if it races,
// since a false negative just falls through to EnsureIfAbsent below,
// which is what actually has to be race-safe: several requests for the
// same user landing in the same instant right after a restart (several
// browser tabs and an SSE reconnect, all reconnecting at once) used to
// each see "not running" from a bare Running() check and each spin up
// their own Aggregator with its own immediate Refresh — confirmed as a
// real, if not fully explained, contributor to a request-volume burst
// live in production.
func warmUpAggregator(ctx context.Context, deps Deps, userID []byte, username string) {
	if deps.Manager.Running(userID) {
		return
	}
	creds, err := deps.SettingsStore.Get(ctx, userID)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load settings to warm up dashboard", "user", username, "error", err)
		}
		return
	}
	deps.Manager.EnsureIfAbsent(deps.AppContext, userID, deps.BuildSources(creds))
}

// loadAndEnsure loads userID's saved Settings and (re)builds their
// Aggregator from them — unconditionally, unlike warmUpAggregator, since
// startSession calls this on every login regardless of whether one's
// already running, to pick up whatever was most recently saved.
func loadAndEnsure(ctx context.Context, deps Deps, userID []byte, username string) {
	creds, err := deps.SettingsStore.Get(ctx, userID)
	if err != nil {
		if !errors.Is(err, settings.ErrNotFound) {
			slog.Warn("could not load settings to warm up dashboard", "user", username, "error", err)
		}
		return
	}
	deps.Manager.Ensure(deps.AppContext, userID, deps.BuildSources(creds))
}

// handleDashboardRefresh triggers an immediate, out-of-band refresh of
// the signed-in user's own dashboard and blocks until it completes,
// returning the resulting snapshot — for retrying right away after a
// forge was only briefly unreachable, instead of waiting out the rest of
// the scheduled REFRESH_INTERVAL.
//
// Like handleDashboardStream, and unlike handleDashboard: no ?owner=,
// only ever the signed-in user's own dashboard, so a user with shared
// access to someone else's dashboard can never spend that owner's own
// forge rate-limit budget on their own schedule.
//
// Passes deps.AppContext to RefreshNow, not r.Context(): coalescer.do
// only threads the *first* caller's context into the shared fetch — every
// later caller that arrives while a run is already in flight just waits
// on that same run. Using the request's own context here would mean a
// closed browser tab could cancel a refresh the scheduled ticker, or
// another tab's own force-refresh click, is depending on.
func handleDashboardRefresh(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		if !deps.Manager.RefreshNow(deps.AppContext, u.ID) {
			// No Aggregator running yet (Settings has never been saved) —
			// the same condition and message handleDashboardStream uses.
			writeJSON(w, http.StatusNotFound, errorBody("no background refresh is running yet for this user"))
			return
		}
		writeJSON(w, http.StatusOK, deps.Manager.Get(u.ID))
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

		warmUpAggregator(r.Context(), deps, u.ID, u.Username)

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
