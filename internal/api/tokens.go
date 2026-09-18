package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// Token matches components.schemas.APIToken — a token's own metadata,
// never the raw value. Named Token, not APIToken, to avoid stuttering as
// api.APIToken from outside the package; auth.APIToken (a different
// package) keeps its own fuller name since auth.Token would collide with
// nothing here but reads less clearly on its own.
type Token struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

func tokenOf(t *auth.APIToken) Token {
	return Token{ID: t.ID, Label: t.Label, CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt, LastUsedAt: t.LastUsedAt}
}

func handleTokensGet(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		tokens, err := store.ListAPITokens(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load api tokens"))
			return
		}

		out := make([]Token, 0, len(tokens))
		for _, t := range tokens {
			out = append(out, tokenOf(t))
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// apiTokenCreateRequest matches components.schemas.APITokenCreateRequest.
type apiTokenCreateRequest struct {
	Label     string    `json:"label"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// apiTokenCreateResponse matches components.schemas.APITokenCreateResponse
// — the one and only response that ever carries the raw token value.
type apiTokenCreateResponse struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	Token     string    `json:"token"`
}

// maxAPITokenLifetime caps how far out expiresAt may be — GitHub's own
// fine-grained personal-access-token maximum (#356), and the reason
// there's no "never expires" option at all: the cap alone forces a
// bound, no separate flag needed to rule that out.
const maxAPITokenLifetime = 366 * 24 * time.Hour

func handleTokensPost(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		var req apiTokenCreateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
			return
		}
		label := strings.TrimSpace(req.Label)
		if label == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("label is required"))
			return
		}
		now := time.Now()
		if !req.ExpiresAt.After(now) {
			writeJSON(w, http.StatusBadRequest, errorBody("expiresAt must be in the future"))
			return
		}
		if req.ExpiresAt.After(now.Add(maxAPITokenLifetime)) {
			writeJSON(w, http.StatusBadRequest, errorBody("expiresAt can't be more than 366 days out"))
			return
		}

		raw, tok, err := store.CreateAPIToken(r.Context(), u.ID, label, req.ExpiresAt)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not create api token"))
			return
		}

		writeJSON(w, http.StatusCreated, apiTokenCreateResponse{
			ID:        tok.ID,
			Label:     tok.Label,
			CreatedAt: tok.CreatedAt,
			ExpiresAt: tok.ExpiresAt,
			Token:     raw,
		})
	}
}

func handleTokensDelete(store *auth.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		id := r.PathValue("id")
		if err := store.DeleteAPIToken(r.Context(), u.ID, id); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not revoke api token"))
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
