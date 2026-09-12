package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// SessionUser matches components.schemas.SessionUser in api/openapi.yaml.
type SessionUser struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	IsAdmin     bool   `json:"isAdmin"`
}

func sessionUserOf(u *auth.User) SessionUser {
	return SessionUser{Username: u.Username, DisplayName: u.DisplayName, IsAdmin: u.IsAdmin}
}

type registerBeginRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

func handleRegisterBegin(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerBeginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || req.DisplayName == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("username and displayName are required"))
			return
		}

		creation, err := svc.BeginRegistration(r.Context(), req.Username, req.DisplayName)
		if err != nil {
			if errors.Is(err, auth.ErrAlreadyRegistered) {
				writeJSON(w, http.StatusConflict, errorBody("username already registered"))
				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not start registration"))
			return
		}
		writeJSON(w, http.StatusOK, creation)
	}
}

func handleRegisterFinish(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username := r.URL.Query().Get("username")
		if username == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("username is required"))
			return
		}

		u, err := deps.AuthService.FinishRegistration(r.Context(), username, r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("registration failed"))
			return
		}

		startSession(w, r, deps, u)
	}
}

type loginBeginRequest struct {
	Username string `json:"username"`
}

func handleLoginBegin(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginBeginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("username is required"))
			return
		}

		assertion, err := svc.BeginLogin(r.Context(), req.Username)
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("no account registered under that username"))
				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not start login"))
			return
		}
		writeJSON(w, http.StatusOK, assertion)
	}
}

func handleLoginFinish(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username := r.URL.Query().Get("username")
		if username == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("username is required"))
			return
		}

		u, err := deps.AuthService.FinishLogin(r.Context(), username, r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("login failed"))
			return
		}

		startSession(w, r, deps, u)
	}
}

func startSession(w http.ResponseWriter, r *http.Request, deps Deps, u *auth.User) {
	token, err := deps.AuthService.CreateSession(r.Context(), u)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not start session"))
		return
	}
	auth.SetSessionCookie(w, token, auth.IsHTTPS(r))

	// Warm up this user's Aggregator from whatever they last saved in
	// Settings — the Manager holds no state across a restart, so this is
	// what makes a returning user's dashboard start refreshing again
	// without a trip to Settings first. A user with nothing saved yet
	// just gets Manager.Get's empty-snapshot default, same as before this
	// ran.
	//
	// deps.AppContext, not r.Context(): the background refresh goroutine
	// Ensure starts has to outlive this one request, and a *http.Request's
	// context is canceled the moment this handler returns.
	if creds, err := deps.SettingsStore.Get(r.Context(), u.ID); err == nil {
		deps.Manager.Ensure(deps.AppContext, u.ID, deps.BuildSources(creds))
	} else if !errors.Is(err, settings.ErrNotFound) {
		slog.Warn("could not load settings to warm up dashboard", "user", u.Username, "error", err)
	}

	writeJSON(w, http.StatusOK, sessionUserOf(u))
}

func handleLogout(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if token, ok := auth.SessionToken(r); ok {
			_ = store.DeleteSession(r.Context(), token)
		}
		auth.ClearSessionCookie(w, auth.IsHTTPS(r))
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGetSession() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errorBody("not authenticated"))
			return
		}
		writeJSON(w, http.StatusOK, sessionUserOf(u))
	}
}

func errorBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}
