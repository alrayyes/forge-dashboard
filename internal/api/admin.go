package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// AdminUser matches components.schemas.AdminUser in api/openapi.yaml.
type AdminUser struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	IsAdmin     bool   `json:"isAdmin"`
	CreatedAt   string `json:"createdAt"`
}

func adminUserOf(u *auth.User) AdminUser {
	return AdminUser{
		Username:    u.Username,
		DisplayName: u.DisplayName,
		IsAdmin:     u.IsAdmin,
		CreatedAt:   u.CreatedAt.Format(time.RFC3339),
	}
}

func handleAdminListUsers(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		users, err := store.ListUsers(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not list users"))

			return
		}

		out := make([]AdminUser, len(users))
		for i, u := range users {
			out[i] = adminUserOf(u)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// targetUser resolves the {username} path value to a *auth.User, refusing
// (400) an admin's own account — neither revoke nor delete has a sensible
// recovery path for the account making the request — and answering 404 for
// a username nobody's registered under.
func targetUser(w http.ResponseWriter, r *http.Request, store *auth.Store) (*auth.User, bool) {
	requester, ok := auth.UserFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

		return nil, false
	}

	username := r.PathValue("username")
	if username == requester.Username {
		writeJSON(w, http.StatusBadRequest, errorBody("can't act on your own account through this endpoint"))

		return nil, false
	}

	target, err := store.GetUserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, auth.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody("no user is registered under that username"))

			return nil, false
		}
		writeJSON(w, http.StatusInternalServerError, errorBody("could not look up user"))

		return nil, false
	}

	return target, true
}

func handleAdminRevokeUser(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		target, ok := targetUser(w, r, deps.AuthStore)
		if !ok {
			return
		}

		if err := deps.AuthStore.RevokeUser(r.Context(), target.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not revoke user"))

			return
		}
		deps.Manager.Remove(target.ID)

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleAdminDeleteUser(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		target, ok := targetUser(w, r, deps.AuthStore)
		if !ok {
			return
		}

		if err := deps.AuthStore.DeleteUser(r.Context(), target.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not delete user"))

			return
		}
		if err := deps.SettingsStore.Delete(r.Context(), target.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not delete user's settings"))

			return
		}
		if err := deps.SharingStore.DeleteUser(r.Context(), target.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not delete user's sharing"))

			return
		}
		deps.Manager.Remove(target.ID)

		w.WriteHeader(http.StatusNoContent)
	}
}

// AdminInvite matches components.schemas.AdminInvite — an outstanding
// invite's own metadata for the admin area's list. ID is the invite's own
// stable identifier (its stored token hash — see auth.Invite's own doc
// comment for why that's safe to hand back), never the raw token itself;
// it's what a revoke call passes back in the {token} path segment.
type AdminInvite struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	ExpiresAt   string `json:"expiresAt"`
}

func adminInviteOf(inv *auth.Invite) AdminInvite {
	return AdminInvite{
		ID:          inv.ID,
		Username:    inv.Username,
		DisplayName: inv.DisplayName,
		ExpiresAt:   inv.ExpiresAt.Format(time.RFC3339),
	}
}

// AdminInviteCreateResponse matches components.schemas.AdminInviteCreateResponse
// — the one and only response that ever carries the raw invite token,
// shown once at creation time; only its hash is stored, so it can't be
// recovered from here again (the same "show once" handling
// APITokenCreateResponse's own token field gets).
type AdminInviteCreateResponse struct {
	Token       string `json:"token"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	ExpiresAt   string `json:"expiresAt"`
}

type adminInviteCreateRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

func handleAdminCreateInvite(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requester, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req adminInviteCreateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || req.DisplayName == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("username and displayName are required"))

			return
		}

		token, invite, err := deps.AuthService.CreateInvite(r.Context(), requester, req.Username, req.DisplayName)
		if err != nil {
			if errors.Is(err, auth.ErrAlreadyRegistered) {
				writeJSON(w, http.StatusConflict, errorBody("username already registered"))

				return
			}
			if errors.Is(err, auth.ErrNotAdmin) {
				writeJSON(w, http.StatusForbidden, errorBody("admin access required"))

				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not create invite"))

			return
		}

		writeJSON(w, http.StatusCreated, AdminInviteCreateResponse{
			Token:       token,
			Username:    invite.Username,
			DisplayName: invite.DisplayName,
			ExpiresAt:   invite.ExpiresAt.Format(time.RFC3339),
		})
	}
}

func handleAdminListInvites(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		invites, err := store.ListOutstandingInvites(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not list invites"))

			return
		}

		out := make([]AdminInvite, len(invites))
		for i, inv := range invites {
			out[i] = adminInviteOf(inv)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func handleAdminRevokeInvite(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("token")

		if err := store.RevokeInvite(r.Context(), id); err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("no outstanding invite with that id"))

				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not revoke invite"))

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
