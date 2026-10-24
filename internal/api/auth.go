package api

import (
	"errors"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// SessionUser matches components.schemas.SessionUser in api/openapi.yaml.
type SessionUser struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

func sessionUserOf(u *auth.User) SessionUser {
	return SessionUser{Username: u.Username, DisplayName: u.DisplayName}
}

func handleRegisterBegin(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		creation, err := svc.BeginRegistration(r.Context())
		if err != nil {
			if errors.Is(err, auth.ErrRegistrationClosed) {
				writeJSON(w, http.StatusForbidden, errorBody("registration is closed"))

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
	// Open is true only when the instance has zero registered users, the one
	// moment POST /api/auth/register/begin is allowed at all. The login page
	// uses this to decide whether to offer its register button.
	Open bool `json:"open"`
}

// handleRegistrationStatus is unauthenticated — a visitor deciding
// whether to show a login page's register button has no session yet by
// definition.
func handleRegistrationStatus(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		registered, err := svc.HasAnyRegisteredUser(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not check registration status"))

			return
		}
		writeJSON(w, http.StatusOK, registrationStatusResponse{Open: !registered})
	}
}

func handleRegisterFinish(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := deps.AuthService.FinishRegistration(r.Context(), r)
		if err != nil {
			if errors.Is(err, auth.ErrRegistrationClosed) {
				writeJSON(w, http.StatusForbidden, errorBody("registration is closed"))

				return
			}
			writeJSON(w, http.StatusBadRequest, errorBody("registration failed"))

			return
		}

		startSession(w, r, deps, u)
	}
}

func handleLoginBegin(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		assertion, err := svc.BeginLogin(r.Context())
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("no passkey is registered yet"))

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
		u, err := deps.AuthService.FinishLogin(r.Context(), r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("login failed"))

			return
		}

		startSession(w, r, deps, u)
	}
}

func startSession(w http.ResponseWriter, r *http.Request, deps Deps, u *auth.User) {
	token, err := deps.AuthService.CreateSession(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("could not start session"))

		return
	}
	auth.SetSessionCookie(w, token, auth.IsHTTPS(r))

	// Start the Aggregator from whatever was last saved in Settings if the
	// process hasn't yet. It normally started at boot, and a settings save
	// rebuilds it, so a sign-in only fills a gap. Rebuilding here would cancel
	// a first refresh that is already running.
	warmUpAggregator(r.Context(), deps)

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

// fieldErrorBody is errorBody for a rejected input that belongs to one field
// of the request, named in `field` (#810).
func fieldErrorBody(field, msg string) map[string]string {
	return map[string]string{"error": msg, "field": field}
}
