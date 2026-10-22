package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// resolveJobLogFor reads the output of one Actions job for u. Shared by
// handleJobLog and the MCP get_check_log tool so the two can't drift.
func resolveJobLogFor(ctx context.Context, deps Deps, u *auth.User, forge, fullName string, jobID int64) (dashboard.JobLog, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return dashboard.JobLog{}, &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}
	if jobID <= 0 {
		return dashboard.JobLog{}, &statusError{http.StatusBadRequest, "jobId must be a positive integer"}
	}

	src, _, serr := lookupForgeSource(ctx, deps, u.ID, forge)
	if serr != nil {
		return dashboard.JobLog{}, serr
	}
	reader, serr := capabilityFor[dashboard.JobLogReader](src, forge, "doesn't support reading job logs")
	if serr != nil {
		return dashboard.JobLog{}, serr
	}

	log, err := reader.JobLog(ctx, owner, name, jobID)
	if err != nil {
		slog.Warn("job log fetch failed", "forge", forge, "repo", fullName, "job", jobID, "error", err)

		return dashboard.JobLog{}, &statusError{clientErrorStatus(err), err.Error()}
	}

	return log, nil
}

// handleJobLog serves resolveJobLogFor over HTTP: a GET that fetches on demand,
// like GET /api/pull-requests/checks, since a log is never part of a snapshot.
func handleJobLog(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		q := r.URL.Query()
		jobID, _ := strconv.ParseInt(q.Get("jobId"), 10, 64)
		log, serr := resolveJobLogFor(r.Context(), deps, u, q.Get("forge"), q.Get("fullName"), jobID)
		if serr != nil {
			serr.write(w)

			return
		}

		writeJSON(w, http.StatusOK, log)
	}
}
