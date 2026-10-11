package dashboard

import (
	"context"
	"log/slog"
	"strings"
	"time"
)

// QueuedActionStore is what an Aggregator needs to run the actions a user
// queued for the reset (#756): their queue, a way to save an outcome, the
// settings a Renovate rebase uses. settings.Store satisfies it. Defined here,
// in the consuming package.
type QueuedActionStore interface {
	QueuedActions(ctx context.Context, userID []byte) ([]QueuedAction, error)
	UpdateQueuedAction(ctx context.Context, userID []byte, q QueuedAction) (bool, error)
	PruneQueuedActions(ctx context.Context, userID []byte, cutoff time.Time) error
	RenovateRebaseLabel(ctx context.Context, userID []byte) (string, error)
	RenovateAuthors(ctx context.Context, userID []byte) ([]string, error)
}

// queuedActionsConfig is nil on an Aggregator that never called
// EnableQueuedActions.
type queuedActionsConfig struct {
	userID []byte
	store  QueuedActionStore
	// wake tells RunQueuedActions the queue changed, so it plans again.
	wake chan struct{}
}

const (
	// queuedFinishedKeep is how long a final outcome stays listed, so a client
	// that wasn't looking can still show it in its Activity list.
	queuedFinishedKeep = 24 * time.Hour
	// queuedUnreachableRetry is how long a forge that doesn't answer at the
	// reset is left before the next try, and queuedUnreachableGiveUp how long
	// after the reset the server keeps trying before it records a failure.
	queuedUnreachableRetry  = 5 * time.Minute
	queuedUnreachableGiveUp = time.Hour
	// queuedMinWait keeps the scheduler from spinning when the store can't
	// save an item that is due.
	queuedMinWait = time.Second
)

// WithQueuedActionBuffer sets how long past a reset the server waits before it
// runs a queued action. It defaults to backoffBuffer, the same pad the refresh
// back-off uses, so the forge has rolled its counter over.
func WithQueuedActionBuffer(d time.Duration) AggregatorOption {
	return func(a *Aggregator) { a.queuedBuffer = d }
}

// EnableQueuedActions turns on running the actions userID queued for a forge's
// rate-limit reset. Nothing else is ever run from the queue.
func (a *Aggregator) EnableQueuedActions(userID []byte, store QueuedActionStore) {
	a.queued = &queuedActionsConfig{userID: userID, store: store, wake: make(chan struct{}, 1)}
}

// QueuedActionsChanged tells the scheduler the queue changed, and subscribers
// to read it again, since a queued action rides next to the snapshot and not
// in it.
func (a *Aggregator) QueuedActionsChanged() {
	if a.queued != nil {
		select {
		case a.queued.wake <- struct{}{}:
		default:
		}
	}
	a.notify(a.Get())
}

// RunQueuedActions is the scheduler: it sleeps until the earliest queued
// action's reset and then runs what is due, until ctx ends. It reads the queue
// from the store every time, so a restart loses nothing and a cancel or a new
// item is seen at the next wake-up.
func (a *Aggregator) RunQueuedActions(ctx context.Context) {
	cfg := a.queued
	if cfg == nil {
		return
	}

	for {
		timer := time.NewTimer(a.untilNextQueued(ctx))
		select {
		case <-ctx.Done():
			timer.Stop()

			return
		case <-cfg.wake:
			timer.Stop()
		case <-timer.C:
		}
		if ctx.Err() != nil {
			return
		}
		a.ProcessQueuedActions(ctx)
	}
}

// untilNextQueued is how long until the earliest waiting action is due, at
// least queuedMinWait. With nothing waiting it is a long time: only a wake-up
// matters then.
func (a *Aggregator) untilNextQueued(ctx context.Context) time.Duration {
	items, err := a.queued.store.QueuedActions(ctx, a.queued.userID)
	if err != nil {
		slog.Warn("queued actions: could not load the queue", "error", err)

		return time.Minute
	}
	wait := 24 * time.Hour
	now := a.now()
	for _, q := range items {
		if q.Status == QueuedWaiting {
			wait = min(wait, q.RunAt.Add(a.queuedBuffer).Sub(now))
		}
	}

	return max(wait, queuedMinWait)
}

// ProcessQueuedActions runs every queued action whose reset has passed. It
// reads the board fresh first (the refresh skips a forge until its reset, so
// this is the first real read), then decides each action against what the
// forge shows now, runs it only if it still applies, and records the outcome.
func (a *Aggregator) ProcessQueuedActions(ctx context.Context) {
	cfg := a.queued
	if cfg == nil {
		return
	}
	items, err := cfg.store.QueuedActions(ctx, cfg.userID)
	if err != nil {
		slog.Warn("queued actions: could not load the queue", "error", err)

		return
	}
	if err := cfg.store.PruneQueuedActions(ctx, cfg.userID, a.now().Add(-queuedFinishedKeep)); err != nil {
		slog.Warn("queued actions: could not prune finished actions", "error", err)
	}
	if len(a.dueQueued(items)) == 0 {
		return
	}

	a.Refresh(ctx)
	// Read the queue again: a cancel during the refresh must win.
	items, err = cfg.store.QueuedActions(ctx, cfg.userID)
	if err != nil {
		slog.Warn("queued actions: could not load the queue", "error", err)

		return
	}
	run := queuedRun{snap: a.Get()}
	run.label, run.authors = a.loadRenovateSettings(ctx)
	for _, q := range a.dueQueued(items) {
		a.runQueued(ctx, run, q)
	}
	a.notify(a.Get())
}

// dueQueued is the waiting actions whose reset, and the buffer after it, has passed.
func (a *Aggregator) dueQueued(items []QueuedAction) []QueuedAction {
	now := a.now()
	var due []QueuedAction
	for _, q := range items {
		if q.Status == QueuedWaiting && !now.Before(q.RunAt.Add(a.queuedBuffer)) {
			due = append(due, q)
		}
	}

	return due
}

func (a *Aggregator) loadRenovateSettings(ctx context.Context) (string, []string) {
	cfg := a.queued
	label, err := cfg.store.RenovateRebaseLabel(ctx, cfg.userID)
	if err != nil {
		slog.Warn("queued actions: could not load the renovate rebase label", "error", err)
	}
	authors, err := cfg.store.RenovateAuthors(ctx, cfg.userID)
	if err != nil {
		slog.Warn("queued actions: could not load renovate authors", "error", err)
	}

	return label, authors
}

// queuedRun is what one pass of ProcessQueuedActions decides with.
type queuedRun struct {
	snap    Snapshot
	label   string
	authors []string
}

// runQueued decides one due action and records the result. The order is the
// safety argument: a forge still limited or down is waited out, a pull
// request that is gone or changed is skipped with the reason, and only a
// pull request that still needs the action gets it.
func (a *Aggregator) runQueued(ctx context.Context, run queuedRun, q QueuedAction) {
	now := a.now()
	if until, limited := RateLimitedUntil(run.snap, q.Forge, now); limited {
		a.rescheduleQueued(ctx, q, until)

		return
	}
	health, known := healthOf(run.snap, q.Forge)
	if !known || a.sourceFor(q.Forge) == nil {
		a.finishQueued(ctx, q, QueuedSkipped, ActionPermission, "No credentials for this forge are saved any more, so nothing was run.")

		return
	}
	if !health.Reachable {
		a.retryUnreachableQueued(ctx, q)

		return
	}
	if !QueueableAction(q.Action) {
		a.finishQueued(ctx, q, QueuedFailed, ActionNotMergeable, "This action can't be queued.")

		return
	}

	pr, found := findPR(run.snap, q)
	if !found {
		a.finishQueued(ctx, q, QueuedSkipped, ActionNotOpen, "Already merged or closed.")

		return
	}
	if code, message := queuedSkipReason(q, pr, run.authors); code != "" {
		a.finishQueued(ctx, q, QueuedSkipped, code, message)

		return
	}

	a.performQueued(ctx, run, q)
}

// queuedSkipReason says why a queued action no longer applies to pr, or
// returns an empty code when it still does. These are the re-checks the
// ticket asks for: caught up, conflicting, already asked for, no longer
// offered.
func queuedSkipReason(q QueuedAction, pr PullRequest, renovateAuthors []string) (ActionCode, string) {
	bot := q.Action != ActionUpdateBranch
	switch {
	case !pr.Behind && bot:
		return ActionAlreadyUpToDate, "The pull request is no longer behind, so the bot already rebased it."
	case !pr.Behind:
		return ActionAlreadyUpToDate, "Already up to date with the base branch."
	case q.Action == ActionUpdateBranch && pr.MergeStatus == MergeConflicting:
		return ActionConflict, "Conflicts need fixing by hand. Resolve them on the forge."
	case bot && pr.BotRequest != nil, !bot && pr.UpdateRequest != nil:
		return ActionAlreadyRequested, "This was already requested on the pull request."
	}

	for _, offered := range AllowedActions(pr, renovateAuthors) {
		if offered.Action != q.Action {
			continue
		}
		if offered.Blocked != nil {
			return offered.Blocked.Code, offered.Blocked.Message
		}

		return "", ""
	}

	return ActionNotMergeable, "This action no longer applies to the pull request."
}

// performQueued makes the one forge call the action stands for, the same call
// the button makes, and records what came of it.
func (a *Aggregator) performQueued(ctx context.Context, run queuedRun, q QueuedAction) {
	owner, name, _ := strings.Cut(q.Repo, "/")
	var err error
	var refusedAs PullRequestAction
	alreadyRequested := false

	switch q.Action {
	case ActionUpdateBranch:
		refusedAs = PullRequestActionUpdateBranch
		updater := a.branchUpdaterFor(q.Forge)
		if updater == nil {
			a.finishQueued(ctx, q, QueuedFailed, ActionUnknown, "This forge can't update pull request branches from here.")

			return
		}
		_, err = updater.UpdateBranch(ctx, owner, name, q.Number)
	case ActionDependabotRebase:
		refusedAs = PullRequestActionDependabot
		commenter := a.commenterFor(q.Forge)
		if commenter == nil {
			a.finishQueued(ctx, q, QueuedFailed, ActionUnknown, "This forge can't send Dependabot commands from here.")

			return
		}
		err = commenter.CommentPullRequest(ctx, owner, name, q.Number, DependabotRebaseComment)
	case ActionRenovateRebase:
		refusedAs = PullRequestActionRenovateRebase
		labeler := a.labelerFor(q.Forge)
		if labeler == nil {
			a.finishQueued(ctx, q, QueuedFailed, ActionUnknown, "This forge can't label pull requests from here.")

			return
		}
		var outcome RenovateRebaseOutcome
		outcome, err = RequestRenovateRebase(ctx, a.sourceFor(q.Forge), labeler, owner, name, q.Number, run.label)
		alreadyRequested = outcome == RenovateRebaseAlreadyRequested
	}

	switch {
	case err != nil:
		a.refusedQueued(ctx, q, refusedAs, err)
	case alreadyRequested:
		a.finishQueued(ctx, q, QueuedSkipped, ActionAlreadyRequested, "A Renovate rebase is already requested on this pull request.")
	default:
		a.recordQueuedRequest(q)
		a.finishQueued(ctx, q, QueuedDone, "", "")
	}
}

// recordQueuedRequest puts the request on the pull request, as a click would.
func (a *Aggregator) recordQueuedRequest(q QueuedAction) {
	switch q.Action {
	case ActionUpdateBranch:
		a.RecordUpdateRequest(q.Forge, q.Repo, q.Number)
	case ActionDependabotRebase:
		a.RecordBotRequest(q.Forge, q.Repo, q.Number, BotDependabot, BotRebase)
	case ActionRenovateRebase:
		a.RecordBotRequest(q.Forge, q.Repo, q.Number, BotRenovate, BotRebase)
	}
}

// refusedQueued records a forge refusal with the structured code a click would
// have been answered with. A rate limit is the one refusal that is waited out.
func (a *Aggregator) refusedQueued(ctx context.Context, q QueuedAction, action PullRequestAction, err error) {
	refusal := ClassifyActionRefusalFor(action, err, nil)
	if refusal.Code == ActionRateLimited {
		next := a.now().Add(queuedUnreachableRetry)
		if refusal.ResetsAt != nil && refusal.ResetsAt.After(a.now()) {
			next = *refusal.ResetsAt
		}
		a.rescheduleQueued(ctx, q, next)

		return
	}
	slog.Warn("queued action failed", "action", q.Action, "forge", q.Forge, "repo", q.Repo, "number", q.Number, "code", refusal.Code, "error", err)
	a.finishQueued(ctx, q, QueuedFailed, refusal.Code, refusal.Message)
}

// retryUnreachableQueued waits a few minutes for a forge that didn't answer at
// the reset, and gives up an hour after it.
func (a *Aggregator) retryUnreachableQueued(ctx context.Context, q QueuedAction) {
	now := a.now()
	if now.Sub(q.RunAt) >= queuedUnreachableGiveUp {
		a.finishQueued(ctx, q, QueuedFailed, ActionUnknown, "The forge didn't answer. Try again in a moment.")

		return
	}
	a.rescheduleQueued(ctx, q, now.Add(queuedUnreachableRetry))
}

// rescheduleQueued keeps q waiting for a later time.
func (a *Aggregator) rescheduleQueued(ctx context.Context, q QueuedAction, runAt time.Time) {
	q.RunAt = runAt.UTC()
	if _, err := a.queued.store.UpdateQueuedAction(ctx, a.queued.userID, q); err != nil {
		slog.Warn("queued actions: could not reschedule", "id", q.ID, "error", err)
	}
}

// finishQueued records the final outcome. An action cancelled meanwhile is not
// in the store any more, and stays gone.
func (a *Aggregator) finishQueued(ctx context.Context, q QueuedAction, status QueuedStatus, code ActionCode, message string) {
	at := a.now().UTC()
	q.Status, q.FinishedAt, q.Code, q.Message = status, &at, code, message
	found, err := a.queued.store.UpdateQueuedAction(ctx, a.queued.userID, q)
	if err != nil {
		slog.Warn("queued actions: could not record the outcome", "id", q.ID, "error", err)

		return
	}
	slog.Info("queued action finished", "found", found, "status", status, "action", q.Action, "forge", q.Forge, "repo", q.Repo, "number", q.Number, "code", code)
}

// sourceFor is the Source driving forge, or nil.
func (a *Aggregator) sourceFor(forge Forge) Source {
	for _, src := range a.sources {
		if src.Forge() == forge {
			return src
		}
	}

	return nil
}

func healthOf(snap Snapshot, forge Forge) (ForgeHealth, bool) {
	for _, h := range snap.Forges {
		if h.Forge == forge {
			return h, true
		}
	}

	return ForgeHealth{}, false
}

func findPR(snap Snapshot, q QueuedAction) (PullRequest, bool) {
	for _, pr := range snap.PullRequests {
		if pr.Forge == q.Forge && pr.Repo == q.Repo && pr.Number == q.Number {
			return pr, true
		}
	}

	return PullRequest{}, false
}
