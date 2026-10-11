package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// queuedActionRequest matches components.schemas.QueuedActionRequest.
type queuedActionRequest struct {
	Action   dashboard.ActionName `json:"action"`
	Forge    string               `json:"forge"`
	FullName string               `json:"fullName"`
	Number   int                  `json:"number"`
}

// handleQueuedActionsList implements GET /api/queued-actions: the signed-in
// user's own queue, waiting and finished. The store scopes it by account, so
// there is no other user's row to leak.
func handleQueuedActionsList(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}
		items, err := deps.SettingsStore.QueuedActions(r.Context(), u.ID)
		if err != nil {
			slog.Error("could not list queued actions", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load queued actions"))

			return
		}

		writeJSON(w, http.StatusOK, items)
	}
}

// handleQueuedActionsCreate implements POST /api/queued-actions (#756). It
// stores the intent and does nothing on the forge: the scheduler runs it once
// the forge's budget is back, after re-reading the pull request.
//
// Every refusal here is for a reason that keeps the unattended write safe:
// only the safe, idempotent actions are queueable, the forge must really be
// limited (otherwise the action can simply be taken), and the pull request
// must be on this user's board and offer the action now.
func handleQueuedActionsCreate(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}
		var req queuedActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if !validQueuedActionRequest(w, req) {
			return
		}

		pr, runAt, ok := queueableTarget(r, w, deps, u.ID, req)
		if !ok {
			return
		}
		now := time.Now()

		item, created, err := deps.SettingsStore.EnqueueQueuedAction(r.Context(), u.ID, dashboard.QueuedAction{
			Action: req.Action, Forge: pr.Forge, Repo: req.FullName, Number: req.Number,
			Status: dashboard.QueuedWaiting, RunAt: runAt.UTC(), CreatedAt: now.UTC(),
		})
		if err != nil {
			slog.Error("could not queue action", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not queue the action"))

			return
		}
		if !created {
			writeJSON(w, http.StatusOK, item)

			return
		}

		deps.Manager.Republish(u.ID)
		writeJSON(w, http.StatusCreated, item)
	}
}

// queueableTarget finds the pull request on userID's board and checks it can
// wait for the reset: its forge really is limited, it is behind, and it offers
// the action. It answers 404 or 409 itself when not, and gives back when the
// forge's budget returns.
func queueableTarget(r *http.Request, w http.ResponseWriter, deps Deps, userID []byte, req queuedActionRequest) (dashboard.PullRequest, time.Time, bool) {
	pr, found := deps.Manager.FindPullRequest(userID, dashboard.Forge(req.Forge), req.FullName, req.Number)
	if !found {
		writeJSON(w, http.StatusNotFound, errorBody("that pull request isn't on your board"))

		return dashboard.PullRequest{}, time.Time{}, false
	}
	runAt, limited := dashboard.RateLimitedUntil(deps.Manager.Get(userID), pr.Forge, time.Now())
	switch {
	case !limited:
		writeQueueRefusal(w, dashboard.ActionNotRateLimited, "The forge isn't rate limited. Do this now instead of queueing it.")
	case !pr.Behind:
		writeQueueRefusal(w, dashboard.ActionAlreadyUpToDate, "Already up to date with the base branch.")
	case refuseIfNotAllowed(r.Context(), w, deps, userID, req.Action, req.Forge, req.FullName, req.Number):
	default:
		return pr, runAt, true
	}

	return dashboard.PullRequest{}, time.Time{}, false
}

// validQueuedActionRequest answers 400 itself for a request that can never be
// queued, whatever the board says. The action check comes first so Merge and
// Close are refused as such, not as a bad repo name.
func validQueuedActionRequest(w http.ResponseWriter, req queuedActionRequest) bool {
	if !dashboard.QueueableAction(req.Action) {
		writeJSON(w, http.StatusBadRequest, errorBody("action must be update_branch, dependabot_rebase or renovate_rebase; merge and close can't be queued"))

		return false
	}
	if overBound(w, bound{"fullName", req.FullName, maxRepoFullNameLen}) {
		return false
	}
	if req.Number > maxPullRequestNumber {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("number", "number is too large"))

		return false
	}
	if _, _, ok := splitFullName(req.FullName); !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

		return false
	}

	return true
}

// writeQueueRefusal answers 409 with the shared ActionError.
func writeQueueRefusal(w http.ResponseWriter, code dashboard.ActionCode, message string) {
	writeJSON(w, http.StatusConflict, actionErrorBody{Error: message, Code: string(code), Message: message})
}

// handleQueuedActionsCancel implements DELETE /api/queued-actions/{id}: it
// removes a waiting item so nothing runs, or clears a finished one. An id that
// is someone else's is indistinguishable from one that doesn't exist.
func handleQueuedActionsCancel(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}
		found, err := deps.SettingsStore.CancelQueuedAction(r.Context(), u.ID, r.PathValue("id"))
		if err != nil {
			slog.Error("could not cancel queued action", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not cancel the queued action"))

			return
		}
		if !found {
			writeJSON(w, http.StatusNotFound, errorBody("no such queued action"))

			return
		}

		deps.Manager.Republish(u.ID)
		w.WriteHeader(http.StatusNoContent)
	}
}
