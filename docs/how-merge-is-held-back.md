# How Merge is held back

This page explains, once, how Merge is held back and released, what an armed
pull request does, and what "waiting" and "stopped" mean. A row says what is
true of that pull request. This page says how the system behaves, so a row
doesn't have to.

The server decides all of it. Each pull request in `GET /api/v1/dashboard`
lists its actions in `allowedActions`, and a blocked one carries a reason. The
page draws what is listed. [Pull request actions](pull-request-actions.md) has
the full rules.

## Merge is held back, not hidden

While something can unlock Merge, the row shows it greyed with the reason beside
it. Hiding it would leave you guessing whether the button was missing or the
pull request wasn't ready. Only an empty pull request, which nothing can unlock,
has no Merge.

A reason is one of two kinds.

- **It clears on its own.** CI is running, the forge is still checking for
  conflicts, or the forge hasn't reported a merge status yet. You wait. Merge
  unlocks as soon as the forge allows it, at the next refresh.
- **Someone has to act.** The branch is behind its base, the pull request is a
  draft, a check failed, there is a merge conflict, or workflow runs are
  waiting for approval. The reason names the fix:
  - Behind the base branch: use Update branch, beside Merge. A Dependabot or
    Renovate pull request offers that bot's rebase instead.
  - Draft: mark it ready for review on the forge.
  - A failing check: fix it. The CI pill and the list of checks show which.
  - A merge conflict: resolve it on the forge. "Conflict not confirmed" means
    the forge hasn't confirmed it yet. Update the branch to find out.
  - Workflow runs waiting for approval: approve them on the forge. They report
    nothing until then, so a failing pill would point you the wrong way.
  - The only run was cancelled: run the checks again.

A pull request stacked on another one keeps Merge locked until the parent
merges and its base moves to the branch it lands on. Merging it earlier lands
it in the parent's branch, not the base it ends up on.

When the forge itself blocks the merge and nothing else here explains it, a
required check or review is missing. That is a rule of the repository, so the
row says only that.

## Armed pull requests

Auto-merge asks the forge to merge a pull request once it can. An armed row
shows a wait chip where a locked Merge would be, with a Cancel auto-merge
button. The server reports one of two states, `waiting` or `stopped`, and a
message that says why.

- **Waiting.** Something short of the forge's go-ahead is missing: checks are
  running, no check has reported yet, the only run was cancelled, the branch
  must be updated, the draft isn't ready, the parent hasn't merged, workflow
  runs need approval, the forge is rate limited, or the forge hasn't said it
  can merge. The chip names it. When that clears, auto-merge carries on without
  you.
- **Stopped.** A check failed, there is a merge conflict, or the forge refused
  the merge, for example over a permission. The message reads "Auto-merge
  stopped:" and the cause. Auto-merge stays armed. After a failed check or a
  conflict it carries on once checks pass or the conflict is resolved. A refusal
  needs whatever the forge said to be fixed first. If the pull request goes
  empty because its branch landed some other way, nothing is left to merge, so
  the app cancels the auto-merge instead.

Once checks have passed, the state is still `waiting`, with the message "Checks
passed". The merge is next. GitHub holds an armed pull request and merges it
itself. Forgejo has no such hold here, so the dashboard merges it at the next
refresh.

When the base branch must be current before a merge, an armed pull request that
is behind waits for someone to update it. The forge doesn't update it for you,
so update the branch.

## What a row keeps

A row keeps what is true of that pull request and where to act: the reason
Merge is blocked, the number of the parent it is stacked on, what an armed pull
request is waiting for. The explanations on this page are not repeated per row.
