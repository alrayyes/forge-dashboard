package dashboard

import (
	"maps"
	"strings"
	"time"
)

// AutoMergeState is whether an armed pull request's auto-merge will clear by
// itself. Matches components.schemas.AutoMergeStatus.state.
type AutoMergeState string

// The states of an armed pull request.
const (
	AutoMergeWaiting AutoMergeState = "waiting"
	AutoMergeStopped AutoMergeState = "stopped"
)

// AutoMergeStatus says in words where an armed pull request stands. Matches
// components.schemas.AutoMergeStatus.
type AutoMergeStatus struct {
	State   AutoMergeState `json:"state"`
	Code    ActionCode     `json:"code,omitempty"`
	Message string         `json:"message"`
}

// AutoMergeFailure is the refusal of the last merge tried on a pull request.
// It speaks for that version of the pull request only: once UpdatedAt moves,
// the pass tries again and the old refusal no longer applies.
type AutoMergeFailure struct {
	UpdatedAt time.Time
	Refusal   ActionRefusal
}

// AutoMerged is a pull request this app merged for its user, kept briefly so
// the page can say so after the pull request has left the board.
type AutoMerged struct {
	Forge  Forge
	Repo   string
	Number int
	At     time.Time
}

// AutoMergeReport is what the pass knows that the snapshot doesn't: why each
// armed pull request's last merge was refused, keyed "forge/owner/repo#number",
// and what it merged in the last few minutes, newest first.
type AutoMergeReport struct {
	Failures map[string]AutoMergeFailure
	Merged   []AutoMerged
}

// autoMergedKeep is how long a merge stays in the report.
const autoMergedKeep = 10 * time.Minute

// AutoMergeStatusOf explains an armed pull request. A refusal of the current
// version outranks what the fields say, since it is what actually happened
// when the merge was tried. A rate limit only waits.
func AutoMergeStatusOf(pr PullRequest, failure *AutoMergeFailure) AutoMergeStatus {
	status := func(state AutoMergeState, code ActionCode, message string) AutoMergeStatus {
		return AutoMergeStatus{State: state, Code: code, Message: message}
	}

	if failure != nil && failure.UpdatedAt.Equal(pr.UpdatedAt) {
		if failure.Refusal.Code == ActionRateLimited {
			return status(AutoMergeWaiting, ActionRateLimited, "Auto-merge is waiting: "+lowerFirst(failure.Refusal.Message))
		}

		return status(AutoMergeStopped, failure.Refusal.Code, "Auto-merge stopped: "+lowerFirst(failure.Refusal.Message))
	}

	switch {
	case pr.MergeStatus == MergeConflicting:
		return status(AutoMergeStopped, ActionConflict, "Auto-merge stopped: merge conflict. Resolve it on Forgejo and it carries on.")
	case pr.CI == CIFailure:
		return status(AutoMergeStopped, ActionChecksFailing, "Auto-merge stopped: a check failed. It carries on once checks pass.")
	case pr.Empty:
		return status(AutoMergeStopped, ActionAlreadyUpToDate, "Auto-merge stopped: nothing left to merge.")
	case pr.Draft:
		return status(AutoMergeWaiting, ActionNotMergeable, "Auto-merge is waiting for the draft to be marked ready.")
	case pr.StackedOn != nil:
		return status(AutoMergeWaiting, ActionStacked, "Auto-merge is waiting for the pull request it is stacked on to merge.")
	case pr.CI == CINone:
		return status(AutoMergeWaiting, ActionChecksPending, "Auto-merge is waiting for a check to report and pass.")
	case pr.CI == CIPending:
		return status(AutoMergeWaiting, ActionChecksPending, "Auto-merge is waiting for checks to finish.")
	case pr.MergeStatus != MergeMergeable:
		return status(AutoMergeWaiting, ActionNotMergeable, "Auto-merge is waiting for Forgejo to say it can merge.")
	}

	return status(AutoMergeWaiting, "", "Checks passed. Auto-merge merges it on the next refresh.")
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}

	return strings.ToLower(s[:1]) + s[1:]
}

// AutoMergeReport returns a copy of what the pass knows, with merges older
// than ten minutes left out.
func (a *Aggregator) AutoMergeReport() AutoMergeReport {
	cfg := a.autoMerge
	if cfg == nil {
		return AutoMergeReport{}
	}

	cfg.mu.Lock()
	defer cfg.mu.Unlock()

	report := AutoMergeReport{Failures: make(map[string]AutoMergeFailure, len(cfg.failures))}
	maps.Copy(report.Failures, cfg.failures)
	for _, m := range cfg.merged {
		if a.now().Sub(m.At) < autoMergedKeep {
			report.Merged = append(report.Merged, m)
		}
	}

	return report
}

// AutoMergeReport delegates to userID's Aggregator; empty for a user with none.
func (m *Manager) AutoMergeReport(userID []byte) AutoMergeReport {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()
	if !ok {
		return AutoMergeReport{}
	}

	return entry.agg.AutoMergeReport()
}

// mergeRefusal explains a refused merge. A "not allowed" from Forgejo
// comes with the same status as an unmergeable pull request, so the
// text decides.
func mergeRefusal(err error) ActionRefusal {
	if strings.Contains(strings.ToLower(err.Error()), "not allowed to merge") {
		return ActionRefusal{Code: ActionPermission, Message: "The token saved for Forgejo isn't allowed to merge this pull request. Check its permissions in Settings."}
	}

	return ClassifyActionRefusal(err, nil)
}
