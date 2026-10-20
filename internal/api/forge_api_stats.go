package api

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// forgeAPIStatsResponse matches components.schemas.ForgeApiStats.
type forgeAPIStatsResponse struct {
	Since   time.Time             `json:"since"`
	Buckets []apistats.Bucket     `json:"buckets"`
	Budgets []forgeAPIBudgetEntry `json:"budgets"`
}

// forgeAPIBudgetEntry matches components.schemas.ForgeApiBudget.
type forgeAPIBudgetEntry struct {
	Forge            dashboard.Forge      `json:"forge"`
	RateLimitGraphQL *dashboard.RateLimit `json:"rateLimitGraphQL,omitempty"`
	RateLimitREST    *dashboard.RateLimit `json:"rateLimitREST,omitempty"`
}

// handleForgeAPIStats serves the forge-API counters (#2008): how many requests
// the dashboard has spent, by credential, refresh kind and repo, since the
// process started.
//
// It returns only the buckets of the caller's own credentials. The counters
// are keyed by credential, not by user, so the filter is the caller's saved
// credentials mapped to the same labels the clients count under; a bucket of
// somebody else's token never leaves the process.
func handleForgeAPIStats(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		creds, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil && !errors.Is(err, settings.ErrNotFound) {
			slog.Error("read credentials for forge api stats", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not read your credentials"))

			return
		}

		warmUpAggregator(r.Context(), deps, u.ID, u.Username)
		deps.Manager.WaitFirstRefresh(r.Context(), u.ID, deps.firstLoadWait())
		snap := deps.Manager.Get(u.ID)

		writeJSON(w, http.StatusOK, forgeAPIStatsResponse{
			Since:   deps.APIStats.Since(),
			Buckets: ownBuckets(deps.APIStats.Snapshot(), creds.StatsCredentials()),
			Budgets: budgetsOf(withRateLimitSeverity(snap.Forges, time.Now())),
		})
	}
}

// ownBuckets keeps the buckets made with one of refs. Never nil, so the JSON
// is an empty array and not null.
func ownBuckets(all []apistats.Bucket, refs []apistats.CredentialRef) []apistats.Bucket {
	own := make(map[apistats.CredentialRef]struct{}, len(refs))
	for _, ref := range refs {
		own[ref] = struct{}{}
	}

	out := []apistats.Bucket{}
	for _, b := range all {
		if _, ok := own[apistats.CredentialRef{Forge: b.Forge, Credential: b.Credential}]; ok {
			out = append(out, b)
		}
	}

	return out
}

func budgetsOf(forges []dashboard.ForgeHealth) []forgeAPIBudgetEntry {
	out := []forgeAPIBudgetEntry{}
	for _, f := range forges {
		out = append(out, forgeAPIBudgetEntry{Forge: f.Forge, RateLimitGraphQL: f.RateLimitGraphQL, RateLimitREST: f.RateLimitREST})
	}

	return out
}
