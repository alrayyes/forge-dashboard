package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
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
		body, err := resolveForgeAPIStatsFor(r.Context(), deps)
		if err != nil {
			slog.Error("read credentials for forge api stats", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody("could not read your credentials"))

			return
		}

		writeJSON(w, http.StatusOK, body)
	}
}

// resolveForgeAPIStatsFor answers the forge-API counters and budgets. Shared by the HTTP
// handler and the MCP get_forge_api_stats tool so the two can't drift.
func resolveForgeAPIStatsFor(ctx context.Context, deps Deps) (forgeAPIStatsResponse, error) {
	creds, err := deps.SettingsStore.Get(ctx)
	if err != nil && !errors.Is(err, settings.ErrNotFound) {
		return forgeAPIStatsResponse{}, fmt.Errorf("read credentials: %w", err)
	}

	warmUpAggregator(ctx, deps)
	deps.Service.WaitFirstRefresh(ctx, deps.firstLoadWait())
	snap := deps.Service.Get()

	return forgeAPIStatsResponse{
		Since:   deps.APIStats.Since(),
		Buckets: ownBuckets(deps.APIStats.Snapshot(), creds.StatsCredentials()),
		Budgets: budgetsOf(snap.Forges),
	}, nil
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
