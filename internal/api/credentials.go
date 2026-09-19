package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// CredentialInfo matches components.schemas.Credential — one passkey's
// own display metadata, never the credential itself.
type CredentialInfo struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
}

func credentialInfoOf(c *auth.Credential) CredentialInfo {
	return CredentialInfo{ID: c.ID, Label: c.Label, CreatedAt: c.CreatedAt}
}

func handleCredentialsGet(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		creds, err := store.ListCredentials(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load passkeys"))

			return
		}

		out := make([]CredentialInfo, 0, len(creds))
		for _, c := range creds {
			out = append(out, credentialInfoOf(c))
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleCredentialsAddBegin starts a ceremony to add another passkey to
// the signed-in account (#355) — the authenticated counterpart to
// handleRegisterBegin, which only ever works for a brand-new account.
func handleCredentialsAddBegin(svc *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		creation, err := svc.BeginAddCredential(r.Context(), u)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not start passkey registration"))

			return
		}
		writeJSON(w, http.StatusOK, creation)
	}
}

func handleCredentialsAddFinish(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		label := strings.TrimSpace(r.URL.Query().Get("label"))
		if label == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("label is required"))

			return
		}

		cred, err := deps.AuthService.FinishAddCredential(r.Context(), u, label, r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("passkey registration failed"))

			return
		}

		writeJSON(w, http.StatusCreated, credentialInfoOf(cred))
	}
}

func handleCredentialsDelete(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		id := r.PathValue("id")
		if err := store.RemoveCredential(r.Context(), u.ID, id); err != nil {
			if errors.Is(err, auth.ErrLastCredential) {
				writeJSON(w, http.StatusBadRequest, errorBody("can't remove the account's last remaining passkey"))

				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not remove passkey"))

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
