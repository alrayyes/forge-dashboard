package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// handleAutoUpdateBranchEnable implements POST
// /api/repos/auto-update-branch/enable: a pure local write to
// settings.Store, never touching the forge itself (#365) — same shape
// as handleRepoIgnore. Idempotent, so a repeat call is a 204, not an
// error.
func handleAutoUpdateBranchEnable(deps Deps) http.HandlerFunc {
	return handleRepoSetting(deps, func(ctx context.Context, store *settings.Store, userID []byte, forge, fullName string) error {
		return store.EnableAutoUpdateBranch(ctx, userID, forge, fullName)
	})
}

// handleAutoUpdateBranchDisable implements POST
// /api/repos/auto-update-branch/disable — the reverse of
// handleAutoUpdateBranchEnable, same request shape, same idempotence.
func handleAutoUpdateBranchDisable(deps Deps) http.HandlerFunc {
	return handleRepoSetting(deps, func(ctx context.Context, store *settings.Store, userID []byte, forge, fullName string) error {
		return store.DisableAutoUpdateBranch(ctx, userID, forge, fullName)
	})
}
