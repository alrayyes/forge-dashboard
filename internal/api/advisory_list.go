package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// resolveAdvisoryListFor reads one repo's open dependency advisories in full:
// it resolves which source answers and has dashboard.AdvisoryLister do the
// fetch. Shared by handleAdvisoryList and the MCP get_repository_advisories
// tool so the two can't drift. A forge that can't say (alerts off, no
// permission, rate limited) is a list with state unknown and the reason, not an
// error. The *statusError carries the HTTP status the handler answers with.
func resolveAdvisoryListFor(ctx context.Context, deps Deps, forge, fullName string) (dashboard.AdvisoryList, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return dashboard.AdvisoryList{}, &statusError{status: http.StatusBadRequest, message: `fullName must be "owner/repo"`}
	}

	src, _, serr := lookupForgeSource(ctx, deps, forge)
	if serr != nil {
		return dashboard.AdvisoryList{}, serr
	}
	lister, serr := capabilityFor[dashboard.AdvisoryLister](src, forge, "doesn't support listing advisories")
	if serr != nil {
		return dashboard.AdvisoryList{}, serr
	}

	list, err := lister.ListAdvisories(ctx, owner, name)
	if err != nil {
		slog.Warn("advisory list fetch failed", "forge", forge, "repo", fullName, "error", err)

		return dashboard.AdvisoryList{}, &statusError{status: clientErrorStatus(err), message: err.Error()}
	}

	return list, nil
}

// handleAdvisoryList serves resolveAdvisoryListFor over HTTP, for the
// advisories dialog on the Main branches page. A GET that answers from the list
// the source kept, or reads the forge when asked to (refresh=true) or when
// nothing is kept, and writes nothing, never part of the snapshot.
func handleAdvisoryList(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if s := r.URL.Query().Get("refresh"); s != "" {
			fresh, err := strconv.ParseBool(s)
			if err != nil {
				(&statusError{status: http.StatusBadRequest, message: "refresh must be true or false"}).write(w)

				return
			}
			if fresh {
				ctx = dashboard.WithFreshAdvisories(ctx)
			}
		}
		list, serr := resolveAdvisoryListFor(ctx, deps, r.URL.Query().Get("forge"), r.URL.Query().Get("fullName"))
		if serr != nil {
			serr.write(w)

			return
		}

		writeJSON(w, http.StatusOK, list)
	}
}
