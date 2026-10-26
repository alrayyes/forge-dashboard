package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// handleRebaseBotsEnable implements POST /api/repos/rebase-bots/enable: a
// local write to settings.Store, never touching the forge itself. Idempotent,
// so a repeat call is a 204, not an error.
func handleRebaseBotsEnable(deps Deps) http.HandlerFunc {
	return handleRepoSetting(deps, func(ctx context.Context, store *settings.Store, forge, fullName string) error {
		return store.EnableRebaseBots(ctx, forge, fullName)
	})
}

// handleRebaseBotsDisable implements POST /api/repos/rebase-bots/disable, the
// reverse of handleRebaseBotsEnable with the same request shape and idempotence.
func handleRebaseBotsDisable(deps Deps) http.HandlerFunc {
	return handleRepoSetting(deps, func(ctx context.Context, store *settings.Store, forge, fullName string) error {
		return store.DisableRebaseBots(ctx, forge, fullName)
	})
}
