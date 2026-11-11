package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestRerunChecks asks the forge to rerun the failed jobs of the
// named pull request's checks (#698) — dashboard.ChecksRerunner's own
// RerunFailedChecks decides how. It answers once the forge has queued them.
func handlePullRequestRerunChecks(deps Deps) http.HandlerFunc {
	return handleGuardedAction(deps, guardedAction[dashboard.ChecksRerunner]{
		allowed:     dashboard.ActionRerunChecks,
		refusal:     dashboard.PullRequestActionRerunChecks,
		unsupported: "doesn't support rerunning checks",
		failure:     "pull request checks rerun failed",
		call: func(ctx context.Context, rerunner dashboard.ChecksRerunner, owner, name string, number int) error {
			return rerunner.RerunFailedChecks(ctx, owner, name, number)
		},
	})
}

// rerunnableAnswer is what GET /api/v1/pull-requests/rerunnable says (#3236).
type rerunnableAnswer struct {
	Rerunnable bool `json:"rerunnable"`
	// Reason is the forge's own sentence for why not, when not.
	Reason string `json:"reason,omitempty"`
}

// handlePullRequestRerunnable implements GET /api/v1/pull-requests/rerunnable:
// would "Rerun failed checks" find a job on this pull request? It reads what
// the rerun reads and restarts nothing. "No" is an answer, not an error: the
// bulk Rerun failed checks control sorts rows by it before sending anything.
// Any other refusal (rate limit, permission) keeps its status.
func handlePullRequestRerunnable(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		number, err := strconv.Atoi(r.URL.Query().Get("number"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("number must be an integer"))

			return
		}
		forge, fullName := r.URL.Query().Get("forge"), r.URL.Query().Get("fullName")
		owner, name, ok := splitFullName(fullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}
		src, _, ok := forgeSource(w, r, deps, forge)
		if !ok {
			return
		}
		prober, ok := capabilityOf[dashboard.ChecksRerunProber](w, src, forge, "doesn't support rerunning checks")
		if !ok {
			return
		}

		err = prober.CanRerunFailedChecks(r.Context(), owner, name, number)
		var clientErr *dashboard.ClientError
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, rerunnableAnswer{Rerunnable: true})
		case errors.As(err, &clientErr) && clientErr.Kind == dashboard.ForgeErrorConflict:
			writeJSON(w, http.StatusOK, rerunnableAnswer{Reason: err.Error()})
		default:
			slog.Warn("pull request rerunnable check failed", "forge", forge, "repo", fullName, "number", number, "error", err)
			writeJSON(w, clientErrorStatus(err), errorBody(err.Error()))
		}
	}
}
