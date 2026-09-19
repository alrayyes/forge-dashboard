package api

import (
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
