package api

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
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

// AdminRequestLogEntry matches components.schemas.RequestLogEntry.
type AdminRequestLogEntry struct {
	LoggedAt   string               `json:"loggedAt"`
	Forge      string               `json:"forge"`
	Account    string               `json:"account,omitempty"`
	Method     string               `json:"method"`
	Endpoint   string               `json:"endpoint"`
	StatusCode int                  `json:"statusCode,omitempty"`
	Outcome    string               `json:"outcome"`
	RateLimit  *dashboard.RateLimit `json:"rateLimit,omitempty"`
}

// adminRequestLogEntryOf maps e to its API shape, resolving e.AccountID
// (a raw, base64-encoded user id — see requestlog.Entry's own doc
// comment) to that account's current username via usernames, built once
// per request by resolveAccountUsernames rather than looked up per row.
func adminRequestLogEntryOf(e requestlog.Entry, usernames map[string]string) AdminRequestLogEntry {
	out := AdminRequestLogEntry{
		LoggedAt:   e.LoggedAt.Format(time.RFC3339),
		Forge:      string(e.Forge),
		Account:    usernames[e.AccountID],
		Method:     e.Method,
		Endpoint:   e.Endpoint,
		StatusCode: e.StatusCode,
		Outcome:    e.Outcome,
	}
	// RateLimitLimit/Remaining/ResetsAt are always set together — see
	// each forge client's own recordRequest — so testing the one is
	// enough to know the other two are populated too.
	if e.RateLimitLimit != nil {
		rl := dashboard.RateLimit{Limit: *e.RateLimitLimit, Remaining: *e.RateLimitRemaining, ResetsAt: *e.RateLimitResetsAt}
		if e.RateLimitCost != nil {
			rl.Cost = *e.RateLimitCost
		}
		out.RateLimit = &rl
	}

	return out
}

// resolveAccountUsernames looks up the current username for every
// distinct, non-empty AccountID across entries, once each — an account
// that's since been deleted (auth.ErrNotFound) is simply left out of the
// map, so adminRequestLogEntryOf's own lookup reports "" for it rather
// than erroring the whole listing over one stale row.
func resolveAccountUsernames(ctx context.Context, store *auth.Store, entries []requestlog.Entry) map[string]string {
	usernames := make(map[string]string)
	for _, e := range entries {
		if e.AccountID == "" {
			continue
		}
		if _, done := usernames[e.AccountID]; done {
			continue
		}
		id, err := base64.RawURLEncoding.DecodeString(e.AccountID)
		if err != nil {
			continue
		}
		u, err := store.GetUserByID(ctx, id)
		if err != nil {
			continue
		}
		usernames[e.AccountID] = u.Username
	}

	return usernames
}

// unresolvedAccountFilter is what requestLogFilterFromQuery falls back to
// when the account query param's username doesn't resolve to a real user
// — a value no stored requestlog.Entry.AccountID can ever equal, since
// base64.RawURLEncoding never produces "!", so the filter matches zero
// rows rather than either erroring or silently matching every account.
const unresolvedAccountFilter = "!unknown-account!"

// requestLogFilterFromQuery reads the optional forge/account filter query
// params GET /api/admin/requests and its /export counterpart both take,
// resolving the account param's username (see QueryRequestLogAccount's
// own doc comment in api/openapi.yaml — usernames are the user-facing
// filter value, not raw account ids) to the internal id
// requestlog.Filter.AccountID actually matches rows on.
func requestLogFilterFromQuery(ctx context.Context, store *auth.Store, r *http.Request) requestlog.Filter {
	filter := requestlog.Filter{Forge: dashboard.Forge(r.URL.Query().Get("forge"))}

	if username := r.URL.Query().Get("account"); username != "" {
		u, err := store.GetUserByUsername(ctx, username)
		if err != nil {
			filter.AccountID = unresolvedAccountFilter

			return filter
		}
		filter.AccountID = base64.RawURLEncoding.EncodeToString(u.ID)
	}

	return filter
}

func handleAdminListRequests(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		entries, err := deps.RequestLog.List(r.Context(), requestLogFilterFromQuery(r.Context(), deps.AuthStore, r))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not list requests"))

			return
		}

		usernames := resolveAccountUsernames(r.Context(), deps.AuthStore, entries)
		out := make([]AdminRequestLogEntry, len(entries))
		for i, e := range entries {
			out[i] = adminRequestLogEntryOf(e, usernames)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// requestLogCSVHeader names every column handleAdminExportRequests
// writes, in the same order requestLogCSVRow builds them in.
var requestLogCSVHeader = []string{
	"loggedAt", "forge", "account", "method", "endpoint", "statusCode", "outcome",
	"rateLimitLimit", "rateLimitRemaining", "rateLimitResetsAt", "rateLimitCost",
}

func requestLogCSVRow(e AdminRequestLogEntry) []string {
	statusCode, rlLimit, rlRemaining, rlResetsAt, rlCost := "", "", "", "", ""
	if e.StatusCode != 0 {
		statusCode = strconv.Itoa(e.StatusCode)
	}
	if e.RateLimit != nil {
		rlLimit = strconv.Itoa(e.RateLimit.Limit)
		rlRemaining = strconv.Itoa(e.RateLimit.Remaining)
		rlResetsAt = e.RateLimit.ResetsAt.Format(time.RFC3339)
		if e.RateLimit.Cost != 0 {
			rlCost = strconv.Itoa(e.RateLimit.Cost)
		}
	}

	return []string{
		e.LoggedAt, e.Forge, e.Account, e.Method, e.Endpoint, statusCode, e.Outcome,
		rlLimit, rlRemaining, rlResetsAt, rlCost,
	}
}

func handleAdminExportRequests(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		entries, err := deps.RequestLog.List(r.Context(), requestLogFilterFromQuery(r.Context(), deps.AuthStore, r))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not export requests"))

			return
		}
		usernames := resolveAccountUsernames(r.Context(), deps.AuthStore, entries)

		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", `attachment; filename="request-log.csv"`)
		writer := csv.NewWriter(w)
		if err := writer.Write(requestLogCSVHeader); err != nil {
			return
		}
		for _, e := range entries {
			if err := writer.Write(requestLogCSVRow(adminRequestLogEntryOf(e, usernames))); err != nil {
				return
			}
		}
		writer.Flush()
	}
}
