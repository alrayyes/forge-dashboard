package api

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// repoSegment is what a forge allows in an owner or repository name. Anything
// else (a dot-only segment, a query or fragment mark, a percent escape, a
// slash) could rewrite the path of the request made with the user's token.
var repoSegment = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9._-]{0,99}$`)

func validRepoSegment(s string) bool {
	return repoSegment.MatchString(s) && strings.Trim(s, ".") != ""
}

// parseJobID reads a decimal job id. A non-empty problem names the rule the
// text broke, in words a caller can act on.
func parseJobID(s string) (id int64, problem string) {
	if s == "" {
		return 0, "jobId is required"
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, "jobId must be digits only"
		}
	}
	id, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, "jobId is too large"
	}
	if id <= 0 {
		return 0, "jobId must be a positive integer"
	}

	return id, ""
}

// jobLogFailure is what a caller is told about a failed read: a fixed
// sentence per kind, never the error itself, which can carry a signed URL.
func jobLogFailure(err error) *statusError {
	status := clientErrorStatus(err)
	switch status {
	case http.StatusForbidden:
		return &statusError{status, "the forge refused to show this job's log"}
	case http.StatusNotFound:
		return &statusError{status, "the forge has no log for this job"}
	case http.StatusTooManyRequests:
		return &statusError{status, "the forge is limiting requests; try again shortly"}
	default:
		// Anything else, a Conflict kind included, is the forge failing: the
		// route has no 409 to give.
		return &statusError{http.StatusBadGateway, "the job's log could not be read"}
	}
}

// repoTracked is true when snap lists fullName on forge. Names compare without
// case, as both forges treat them.
func repoTracked(snap dashboard.Snapshot, forge, fullName string) bool {
	return slices.ContainsFunc(snap.Repos, func(r dashboard.Repo) bool {
		return string(r.Forge) == forge && strings.EqualFold(r.FullName, fullName)
	})
}

// resolveJobLogFor reads the output of one Actions job for u. Shared by
// handleJobLog and the MCP get_check_log tool so the two can't drift.
func resolveJobLogFor(ctx context.Context, deps Deps, u *auth.User, forge, fullName string, jobID int64) (dashboard.JobLog, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok || !validRepoSegment(owner) || !validRepoSegment(name) {
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

	// A repository the dashboard doesn't track is one the person never added;
	// the token could still read it, so refuse before the forge is called.
	warmUpAggregator(ctx, deps, u.ID, u.Username)
	deps.Manager.WaitFirstRefresh(ctx, u.ID, deps.firstLoadWait())
	snap := deps.Manager.Get(u.ID)
	if len(snap.Repos) == 0 {
		// A cold start, an outage or a slow first refresh also looks like this,
		// so it can't be told apart from "not tracked": ask the caller to retry.
		return dashboard.JobLog{}, &statusError{http.StatusServiceUnavailable, "your repositories aren't loaded yet, retry shortly"}
	}
	if !repoTracked(snap, forge, fullName) {
		return dashboard.JobLog{}, &statusError{http.StatusNotFound, "that repository isn't on your board"}
	}

	log, err := reader.JobLog(ctx, owner, name, jobID)
	if err != nil {
		slog.Warn("job log fetch failed", "forge", forge, "repo", fullName, "job", jobID, "error", redactURLs(err))

		return dashboard.JobLog{}, jobLogFailure(err)
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
		jobID, problem := parseJobID(q.Get("jobId"))
		if problem != "" {
			writeJSON(w, http.StatusBadRequest, errorBody(problem))

			return
		}
		log, serr := resolveJobLogFor(r.Context(), deps, u, q.Get("forge"), q.Get("fullName"), jobID)
		if serr != nil {
			serr.write(w)

			return
		}

		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		writeJSON(w, http.StatusOK, log)
	}
}

var urlInText = regexp.MustCompile(`https?://\S+`)

// redactURLs is err's text with every URL taken out, for the log: a signed
// blob URL in it would put a working credential there.
func redactURLs(err error) string {
	return urlInText.ReplaceAllString(err.Error(), "<url>")
}
