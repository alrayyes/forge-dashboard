package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// stateAction is a write endpoint that asks the forge to change a pull
// request's state and answers 204: the shape Close and Reopen share. C is the
// optional capability the forge client must have, call is what it does with it
// and settle is what the aggregator is told once the forge agreed.
type stateAction[C any] struct {
	action      dashboard.PullRequestAction
	unsupported string
	logMessage  string
	call        func(ctx context.Context, c C, owner, name string, number int) error
	settle      func(deps Deps, t actionTarget)
}

func handleStateAction[C any](deps Deps, a stateAction[C]) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.req.Forge)
		if !ok {
			return
		}
		capability, ok := capabilityOf[C](w, src, t.req.Forge, a.unsupported)
		if !ok {
			return
		}

		if err := a.call(r.Context(), capability, t.owner, t.name, t.req.Number); err != nil {
			slog.Warn(a.logMessage, "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, capability, a.action, t.owner, t.name, t.req.Number, err)

			return
		}

		a.settle(deps, t)
		w.WriteHeader(http.StatusNoContent)
	}
}
