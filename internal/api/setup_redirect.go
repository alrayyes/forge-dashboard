package api

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
)

// setupPath is where the browser lands after a sign-in or an install. The
// page reads what happened from the API; the query only says what failed.
const setupPath = "/setup"

// The values of components.schemas.SetupErrorCode.
const (
	setupErrAccessDenied             = "access_denied"
	setupErrInvalidState             = "invalid_state"
	setupErrExchangeFailed           = "exchange_failed"
	setupErrAccountUnreadable        = "account_unreadable"
	setupErrSaveFailed               = "save_failed"
	setupErrNotConnected             = "not_connected"
	setupErrInstallationUnverified   = "installation_unverified"
	setupErrInstallationsUnavailable = "installations_unavailable"
)

// redirectSetupError sends the browser back to the setup page with a code.
// The code is one of a fixed list: nothing the forge said is passed on.
func redirectSetupError(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, setupPath+"?"+url.Values{"error": {code}}.Encode(), http.StatusSeeOther)
}

// setupErrorFor names why a sign-in did not finish.
func setupErrorFor(forge string, err error) string {
	switch {
	case errors.Is(err, oauth.ErrInvalidState):
		return setupErrInvalidState
	case errors.Is(err, oauth.ErrExchange):
		slog.Warn(forge + " oauth: code exchange refused")

		return setupErrExchangeFailed
	case errors.Is(err, oauth.ErrAccount):
		slog.Warn(forge + " oauth: could not read the account")

		return setupErrAccountUnreadable
	default:
		slog.Warn(forge + " oauth: could not store the token")

		return setupErrSaveFailed
	}
}
