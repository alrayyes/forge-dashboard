package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
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
	// InviteToken is only required once any account already exists — see
	// RegistrationStatus/handleRegistrationStatus. Left blank, it's still
	// how the very first (bootstrap) registration on a fresh instance
	// works, since Service.BeginRegistration never even looks at it in
	// that case.
	InviteToken string `json:"inviteToken"`
}

func handleRegisterBegin(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerBeginRequest
		// displayName is only required with no inviteToken — the bootstrap
		// path, where nothing else supplies one. An invite-scoped
		// registration never sends a typed displayName at all (the login
		// page's invite flow shows no field for it): the invite's own
		// displayName is what Service.BeginRegistration actually uses,
		// so an empty one here isn't a client error.
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || (req.InviteToken == "" && req.DisplayName == "") {
			writeJSON(w, http.StatusBadRequest, errorBody("username and displayName are required"))

			return
		}

		creation, err := svc.BeginRegistration(r.Context(), req.Username, req.DisplayName, req.InviteToken)
		if err != nil {
			if errors.Is(err, auth.ErrAlreadyRegistered) {
				writeJSON(w, http.StatusConflict, errorBody("username already registered"))

				return
			}
			if errors.Is(err, auth.ErrInvalidInvite) {
				writeJSON(w, http.StatusForbidden, errorBody("invalid, expired, or already-used invite"))

				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not start registration"))

			return
		}
		writeJSON(w, http.StatusOK, creation)
	}
}

// registrationStatusResponse matches components.schemas.RegistrationStatus.
type registrationStatusResponse struct {
	// Open is true only when the instance has zero registered users — the
	// one moment self-registration (POST /api/auth/register/begin with
	// no inviteToken) is allowed at all. The login page uses this to
	// decide whether to offer its own self-serve "Register a new passkey
	// instead" button.
	Open bool `json:"open"`
}

// handleRegistrationStatus is unauthenticated — a visitor deciding
// whether to show a login page's register button has no session yet by
// definition.
func handleRegistrationStatus(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hasAdmin, err := svc.HasAnyRegisteredUser(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not check registration status"))

			return
		}
		writeJSON(w, http.StatusOK, registrationStatusResponse{Open: !hasAdmin})
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
	// without a trip to Settings first. Unconditional, unlike
	// warmUpAggregator's use elsewhere: a login is a deliberate moment to
	// pick up whatever was most recently saved, not just a gap to paper
	// over. A user with nothing saved yet just gets Manager.Get's
	// empty-snapshot default, same as before this ran.
	loadAndEnsure(r.Context(), deps, u.ID, u.Username)

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
