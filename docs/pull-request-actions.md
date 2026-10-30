# Pull request actions

Which actions a row offers, and why a blocked one is blocked, come from the
server: each pull request in `GET /api/v1/dashboard` carries a list named
`allowedActions`, and the page renders what is listed without any rules of its
own. Only
live state is the page's: a rate-limited or unreachable forge, a missing token,
an action already in flight.

One entry in `allowedActions` can carry `primary: true`, the action the row and
the phone card draw as the main button. The server picks it, so no client does.
Merge is primary when it is offered and not blocked, unless CI is failing. An
empty pull request has Close. When being behind the base branch is what holds
Merge back, Update branch is primary, or the Renovate or Dependabot rebase for a
bot pull request. A behind bot pull request has its rebase as primary whatever
else holds Merge back (checks running or failing, auto-merge armed), so a stale
bot branch can be fixed from the row. A conflict, a draft or a stacked pull
request never qualifies, and neither does one whose checks are held for workflow
approval, which a rebase can't release. Update branch is offered while checks run
too, but never as the primary action, since the reason Merge is waiting is the status
then. Like it, the rebase is
offered while checks run: it does restart them, but only when someone clicks
it, and a stuck bot pull request is the case it is for. A rebase that is
already requested is not listed at all, so it is not primary: Renovate's lists
the cancel instead, and Dependabot's lists nothing, since it has no command to
withdraw a request. Every other state has no primary action: a blocked, waiting,
conflicting, draft or stacked pull request leaves its reason to `status`. A
blocked action is never primary, and at most one entry is.

The row draws one button: the primary action, or, while Merge is locked, the
greyed Merge with its reason. A pull request with neither draws none, so a
draft, one waiting on CI, one with failing CI and one with nothing to act on
show their status and nothing to click, except a behind bot pull request, which
shows its rebase (or, once a Renovate rebase is requested, its cancel). A behind
bot pull request that is ready to merge keeps Merge as its main button and
draws its rebase beside it, or the cancel while a Renovate rebase is requested.
A pull request that is behind the base branch is the one case where
a locked Merge is not the row's button: the row draws no button of its own,
because the cure (Update branch, or the bot's rebase) sits inside the status
block above, and the greyed Merge is in the pop-up. A behind bot pull
request whose Merge is held back by something else too (checks running, say)
draws its rebase on the row. Every other action is in the pop-up's footer, one
click away, and there is no "More actions" menu.

When runs wait for someone to approve them, that is the reason Merge gives,
ahead of being behind the base branch, whatever the merge state the forge
reports (blocked, or not yet known) and for any author. A single held run is
enough, even when a missing review also blocks Merge, since the approval is the
one step that is sure to be needed. Checks that are still running are a plain
wait and keep their own reason. For a behind pull request in that state, Update
branch, the Renovate and Dependabot rebases and Dependabot's Recreate are listed
but blocked with the approval reason, because a new head would be held again.
Each says to approve the runs first, then it can run. None is primary, so the
status shows the approval with no `action`, and the blocked Update branch and
rebases show locked on the row with that reason, Recreate in its menu. A
stacked, draft or empty pull request keeps what it had, and so does one that is
not behind. A conflicting pull request is never in this state, so its rebase
stays. Once the runs are approved, the pull request is an ordinary behind one
and Update branch is primary again.

Each pull request also carries `status`: the one reason it is waiting on
something or can't be merged (a check still running, a conflict, a draft, a
parent it is stacked on), with the same `code`, `message` and `next` as a
blocked action. It is null when nothing holds the pull request back. An empty
pull request, whose branch is already on the target, offers `close` and no
`merge` or `auto_merge`, since nothing can unlock Merge; its `status` says there
is nothing to merge.

The row shows `status` in one place, a block with an icon and words above its
actions, and a locked Merge is described by it, so the reason is read without
hovering. A pull request with no status has no block.

When the status is "Behind the base branch", it also carries `action`: the
action that clears it, Update branch or the Dependabot or Renovate rebase.
It is the same action the server marks `primary`. The page draws that button
inside the row's status block and leaves out the row's own copy, so the
warning and its cure are one control. The pop-up's footer still lists every
action. A conflict, a check still running and a draft have no `action`, and
neither does a Renovate pull request whose rebase is already waiting, which
shows the cancel in the row. Once Renovate has taken the request and is
rebasing, the cancel goes too: clearing the box then withdraws nothing, so the
row keeps only the waiting chip.

The details pop-up (see Pull request pages) draws the same actions in its
footer, built by the same code as the row's buttons so the two cannot disagree.
The order in the footer is the primary action first, then the others, then Close
pull request last. The status block under the pop-up's header is the same
`status` message the row shows, and a locked Merge in the footer is described by
it. Their ids carry a `dlg-` prefix, so the row and the pop-up never repeat one.

A pull request stacked on another open one shows a chip with its place and what
it waits for: `Stack 2 of 3 · waits for #840` (the number is the pull
request it is stacked on), or `Stack 1 of 3 · merges first` for the bottom.
The members sit together in position order, at the slot of the
first one in the list, as a plain nested list with a thin rule beside each row.
A filter that matches any member keeps the whole stack and dims the rest. A
child says it targets its parent's branch, not main, so auto-merge isn't
offered, and its Merge shows the server's reason. Tapping the chip lists the
stack. On a phone the chip is short, what it waits for goes on a second line,
and the title is what gets cut. The server works out stacks from the branches
(`stack`, `stackedOn` and `stackChildren` on each pull request).

On GitHub, a pull request whose workflow runs are held until someone approves
them (`awaitingWorkflowApproval`) doesn't read "Failed". The CI pill says
"Waiting for workflow approval" and still opens the pipeline panel. An "Approve
on GitHub" link beside it opens the pull request's checks page in a new tab,
where GitHub's own button approves the runs. The dashboard doesn't approve
anything itself. The locked Merge button says the runs are waiting for approval.
The pipeline panel lists each held workflow as "Waiting for approval", with an
"Approve on GitHub" link to that run's page, once per workflow even when a rerun
left several held runs. Where a required check never reported, the held workflow
is what holds the merge back, so it sits with the required checks and says
"Blocking". The Failing CI quick filter and the Failed number in the menu pill
follow one answer from the server, `failingCi`, which leaves these pull requests
out when held runs are the only failure: nothing failed, someone has to approve.
A job that really failed beside a held run still counts as failed. With
auto-merge armed, the status line says it is waiting for workflow approval, not
that a check failed.

A pull request row draws what it shows as three tiers. A **state**
(`Running`) and the **outcome** it leads to (`Failed` or `Passed`) share one
CI slot: one pill of a fixed size with a glyph and a word, so a finished run
turns into its result in the same place and the row doesn't move. The glyphs
are the ones in the pipeline panel, and `Failed` is the heaviest weight. The
running glyph spins, and holds still under reduced motion. An **attribute** is
something set on the pull request that holds until someone changes it:
`Auto-merge` on, `Draft`, `Bot` (a Dependabot or Renovate pull request),
`Out of date` and the automatic branch update. The Bots page leaves `Bot` out
of its rows, since every row there is a bot's; the details pop-up still shows
it.
Attributes are quiet outlined chips with a small icon and no fill or motion,
in a cluster beside the CI slot, never inside it. `Out of date` is the one
exception: it is drawn for every pull request that is behind its base and has
something left to merge, on the overview and the Bots page alike, in the
warning colour on a tinted fill with a larger icon and heavier text, so a stale
pull request stands out. It is readable in both themes (4.5:1 for the words,
3:1 for the outline). Conflicts and Blocked stay
as merge pills, since they say what the merge needs. On a phone the CI slot sits
at the top right and the attributes take a line of their own.

Merge is clickable when the forge reports the merge is actually possible, and
it's the row's button when it is the primary action. Otherwise it stays on the
row, locked
(`aria-disabled`, no click), with the reason printed beside it: "Waiting for CI
to finish" (it unlocks on its own at the next refresh), a merge conflict, a
draft, a branch that's behind, or "Blocked by the forge" when the forge says no
without saying why. A failing check is named only when CI itself reports
failing. A token missing the right permission, or the forge being unreachable,
locks it too. Merge asks for confirmation first: the button turns into Confirm
and Cancel, and the step ends on Cancel, a click anywhere else (which still does
what it would have done), Escape, or after 8 seconds, shown by a thin line that
runs down and waits while the pointer or keyboard focus is in the pair. A line
under the buttons reminds you that Escape or a click elsewhere cancels. Only one
Merge or Close is armed at a time, and a double-click on Merge arms it without
confirming. If the forge still refuses,
the server re-reads the pull request and answers with a code and a short
reason, which the row and a toast show: already merged or closed (the row
switches to "Merged" or "Closed" and drops off the list on the next snapshot),
a conflict, behind the base branch, a check pending or failing, branch
protection, a missing permission, or a rate limit with its reset time. The
codes are in `api/openapi.yaml` (`ActionError`). A Merge or Close that succeeds
takes the pull request off the board at once, even if the forge goes on listing
it as open for a few seconds; the server holds it back for up to two minutes.
Update branch appears when the
forge reports it's possible; it doesn't ask, since a merge from the base branch
is easy to reverse and a merge itself isn't. A GitHub pull request counts as
behind whenever its base has commits it lacks, even in a repo that doesn't
require branches to be up-to-date, and Merge stays allowed there. On a pull
request that's behind but also conflicts with its base, Update branch is locked
with a note that the conflicts need fixing by hand, since the forge would refuse
the update. Close is in the pop-up's footer on every open pull request,
regardless of mergeability, and on the row only when it is the primary action
(a pull request whose branch is already on the base). It reads "Close pull
request" and is a neutral button, never green or red: closing is reversible,
since the pull request stays listed as closed and can be reopened, so the
warning tone is kept for the confirm step ("Confirm close pull request?"). For
one that turns out not to need merging at all (a duplicate, or one whose content
already landed another way) it's the action that applies. It asks for
confirmation the same way Merge does. Escape drops an unconfirmed Close. If the
forge refuses a confirmed Close, the button reads locked and the reason is its
description. The row says so too, in a short note under its status: "Close
locked" and the reason, in words. That way you don't open every pop-up to find
the refused one. The note goes when the lock does: a permission lock stands
until you dismiss the failure line, and a rate-limit lock clears on the next
refresh.
A Close from the pop-up doesn't shut it. The pop-up stays on the pull request,
the header says "Closed", and the footer offers "Reopen pull request" with focus
on it, so a slip is one press from undone. There is no timer: Reopen stays until
you close the pop-up, and a screen reader hears "Closed. Reopen it if that was a
mistake." once. The confirm step before Close stays, because a closed pull
request can leave a branch behind that a reopen can't bring back. Reopen puts
the pull request back on the board with a refresh and returns the pop-up to its
normal footer. Closing the pop-up without reopening leaves it off the board, as
before. The dashboard can't know in advance whether the forge will reopen a pull
request, so it asks and reads the refusal: one that was merged says "It was
merged in the meantime, so it can't be reopened.", and one the forge won't
reopen, usually because its branch was deleted or rewritten, says so in words
and drops Reopen, leaving the link to the forge.
A permission or rate-limit refusal reads the same as for any other action, and a
forge error keeps Reopen with Retry and Copy.
A permission refusal is re-read too: if the pull request turns out to be
merged or closed, that is what the row says, not "check your token". Only a
rate limit skips the re-read, since it would be limited as well.

An issue's pop-up closes the same way, with a confirm step, a Closed header and
Reopen as the undo, and adds a comment that posts before the close. See
[Closing an issue from its pop-up](issues.md#closing-an-issue-from-its-pop-up).
On Forgejo a rate limit comes from a proxy in front of it, and its reset time is
read from the `Retry-After` header. Forgejo's API says only whether a pull
request can be merged, not why, so a Merge it refuses on a pull request that
can't be merged is reported as a probable conflict, with the message saying it can't
tell a conflict from a merge check that is still running. A missing review or
check is named when the refusal's own text names it.

Every other action (Close, Update branch, Enable auto-merge, Dependabot and
Renovate `rebase`) answers a refusal the same way as Merge. A pull request found
already merged or closed switches its row to "Merged" or "Closed" with a polite
toast, whichever button was clicked. Otherwise the reason is in plain words,
and Retry shows only for a reason that can pass by itself. A few codes belong
to one action: update branch can say there is nothing to bring in,
Enable auto-merge can say the repo doesn't allow it or that the pull request is
already ready to merge, and Renovate `rebase` can say the label is missing on the
repo.

On Forgejo, Close on a pull request that is already closed is not refused.
Forgejo treats it as done and answers success, so the dashboard shows no
"already closed" message: the pull request is closed, which is what was asked.
Closing one that is already merged is refused, and the row says "Merged". Merge
is refused on both, and the server classifies it as `already_merged` or
`already_closed` from the re-read.

A locked action offers Retry only when waiting might fix it, such as a 502. When
a forge's API budget is spent, the forge goes read-only: the controls that need
that budget (Merge, Update branch, the Dependabot and Renovate commands, Close
and, on its GraphQL budget, Enable auto-merge) are not drawn at all, and one
banner at the top says so for that forge ("GitHub is rate limited. Read-only
until 14:32.") with a live countdown. When only one budget is spent the banner
names what is affected. REST drives Merge, Update branch, the bot commands and
Close, and GraphQL drives auto-merge, so the others keep working. A "What still
works" disclosure under the banner lists the read-only actions: the pipeline
panel, the link to the pull request on the forge, and browsing and filtering the
last data. A "Why?" under the banner explains the limit in a few sentences, so
it isn't taken for a fault in the dashboard, and for GitHub links to its own
rate limit rules. For the full explanation, see [Rate limits](rate-limits.md).
Other forges are unaffected. The controls come back by themselves at the reset
time, with a polite "Rate limit reset, actions available again" toast. While the
forge is read-only the server stops refreshing it until the reset, so the rows
are the last ones it saw. The header's Refreshed time shows how old they are.

A row names its forge kind, not the host. With several hosts of one kind,
the controls are held back only when every one of them is unreachable or out
of budget, and the Dependabot commands only when every one of them can't
send them. With one host down and another healthy the controls still draw,
and a click on a row from the down host fails with the forge's own answer. The
queue button is not offered while any host of the kind is unreachable.

A forge that can't be reached gets the same treatment. Its controls are not
drawn either, and no row carries a Retry or a pointer to a status line. One
banner that stays in view while you scroll, on a phone too, says "GitHub is
unreachable. Showing the last data from 14:32.", gives the cause in plain words,
and has the one Retry, which forces a refresh. GitHub's row also links to
githubstatus.com in a new tab, so you can see whether GitHub is reporting an
incident; a Forgejo instance is self-hosted and has no such page. When the forge
answers again the
controls return without a reload, with a polite "GitHub is reachable again,
actions available" toast, and the banner clears. A row's own reason for Merge
(stacked, waiting for CI) shows whenever its forge can be reached.

A missing token permission locks that action on that pull request, with no Retry
either, and the reason points to Settings. Other pull requests and other actions
stay usable, since a fine-grained token can lack one permission and have the
rest. The lock lasts as long as the failure line that explains it: dismiss the
line and the action is free again, with no reload. A failure line stays on its
row however many refreshes arrive, and goes when you dismiss it, act on the row
again, or the row leaves the board. The exception is a failure that passes by
itself, one where the request never got an answer (it says "Couldn't reach the
server"), a forge answered 502, 503 or 504, or the forge failed on its own side
with a 5xx of its own. The last one has the code `forge_error` and says "The
forge had a server error. Try again in a moment." instead of the forge's own
words. Update branch is tried a second time on the server first, after a short
wait, since asking again changes nothing it shouldn't; every other action is
left for you to retry. A request that gets no answer is not taken as a failure
straight away. Update branch, Merge, Close, Enable auto-merge and Cancel
auto-merge read the pull request again first and, when it shows the action ran
(no longer behind, gone from the board, closed, or with auto-merge on or off),
settle on that with no error. Rerun failed checks does not: a rerun leaves
nothing in a snapshot that tells it from a pull request whose checks changed for
another reason, so a rerun request that gets no answer says so and can be
retried. The refresh an action asks for once the forge has accepted it never
reports an error of its own: if that call drops, the action still counts as
done and the next poll brings the board up to date. Copy holds the status the forge
answered with
(`upstreamStatus`) and, from GitHub, its request id (`requestId`), which is what
its support asks for, and the server log line carries both. That line clears
itself after ten seconds, holds while you hover it or have focus in it, and when
it clears the row is read again from the server, since the write may have landed
before the connection dropped. Nothing is announced when it clears, the failure
stays in Activity, and an error toast waits for you as before. A 429 on a click
the snapshot hadn't foreseen still greys that one action out with its reason
until the next snapshot. The header shows each forge's remaining budget and
reset time as text, one line per budget and labelled ("GH GraphQL", "GH REST"),
since GitHub keeps the two apart. A remaining count above its limit shows how
many are left and no ratio. Which locks offer Retry follows the refusal's `code`
(`rate_limited` and `permission` don't), not the words in its message. The
banner at the top of the page follows how much of each budget is left (see
[Rate limits](rate-limits.md#what-the-dashboard-shows)). The server sends the
numbers and the page grades them against its own clock.

While a forge is rate limited, you can queue Update branch, `Dependabot: Rebase`
or `Renovate: Rebase` to run when its budget comes back, instead of returning to
click again. `POST /api/v1/queued-actions` stores the choice on the server,
so it survives a page reload and a server restart. The pull request
carries the waiting item as `queued`, for a row to show a waiting chip, `Queued
· 14:32` with `Resets in 8m` and `Cancel` (the "Queue update" button comes back
once you cancel), and the dashboard's `queuedActions` list holds the items and,
once they ran, their outcomes for 24 hours.

It only works while the forge really is limited (a spent budget whose reset is
still ahead), for a pull request that is on your board, behind its base branch
and offering that action. At the reset, plus a 30-second pad, the server reads
the board fresh and looks at the pull request again before it does anything. It
runs the action only if it still applies. Otherwise it records why it did
nothing: the pull request was merged or closed, caught up, picked up a conflict,
or already has the request. A forge that is still limited moves the item to the
new reset. One that doesn't answer is tried again every five minutes for an hour.
A refusal is recorded with the same `code` and `message` the button would have
shown. It runs with your own saved credentials for that forge and no one else's,
and does nothing if you have removed them.

Merge and Close can't be queued, and the API answers 400. They would act
unattended on a pull request whose checks or commits may have changed in the
meantime. To merge once the limit lifts, arm the forge's own auto-merge instead.
After a restart the server starts the dashboard if an action is waiting, so
the action still runs at the reset without anyone signing in.

On the page, a pull request that is behind its base on a forge whose REST budget
is spent gets a button where Update branch would have been: "Queue update for
14:32", or `Queue rebase for 14:32` for a Dependabot or Renovate pull request.
Queueing posts to `/api/v1/queued-actions`. The row then says "Update branch
queued for 14:32" with a Cancel button, and Activity lists the item with Cancel
(or Clear, once it has finished). When an outcome arrives while the page is
open, a polite toast and the Activity list say whether it was done, skipped with
the reason ("Already merged") or failed. No queue button is offered for Merge or
Close, for a pull request that isn't behind, or while the forge has budget left.

A forge that fails a refresh keeps showing its last good pull requests and
issues, and the header says so next to it: "Showing data from 3m ago". The
time comes from the server's `staleSince`, which is gone again after the next
good refresh.

A GitHub pull request that isn't already auto-merging gets an "Enable
auto-merge" action in the pop-up's footer, arming the forge's
own native auto-merge (GitHub's `enablePullRequestAutoMerge` mutation)
instead of switching to GitHub's own UI just to turn it on. It picks a
merge method the repo actually allows, the same `merge` > `squash` >
`rebase` precedence Merge already uses, with no override of its own.
Merge is skipped when the default branch requires linear history.
A squash, from Merge or from auto-merge, is titled with the pull request's own
title and its number, `title (#N)`, whatever commits the branch holds, so a stray
commit message can't become the subject and the changelog entry.
Available whenever the pull request isn't a genuine conflict — unlike
Merge, a pending or not-yet-required check doesn't hide it, since
arming auto-merge ahead of CI finishing is the whole point. It only
shows when GitHub itself will accept the request (`viewerCanEnableAutoMerge`):
a stacked pull request whose base branch has no protection rule has
nothing to wait for, so GitHub refuses it and the action stays hidden.
When GitHub's answer isn't known, the action shows as usual.

On Forgejo this app does the merge itself. "Enable auto-merge" stores your
intent for that pull request and sends nothing to Forgejo. The pull request
then shows "Auto-merge on" and "Managed by Forge Dashboard", and a waiting chip
(below) with a `Disarm` button. The note follows the server's `autoMergeHeldBy`
field: a merge scheduled on Forgejo itself reads "Scheduled on Forgejo", and
when the server doesn't say who holds it the chip has no note, since the page
never guesses. After each refresh the server merges an armed
pull request once its checks have passed and Forgejo says it can merge, with
the repo's own merge method, the same as Merge. A pull request you didn't arm
is never merged. Checks that fail, conflicts, a draft, a stack parent that
hasn't merged yet or no checks at all keep it waiting, and it merges once that
clears. The row says which, in words: the chip reads `Waiting for CI`, `Waiting
for parent`, `Rate limited` and so on, and a text line says it stopped (a
failed check, a conflict, or a refused merge, including a token without merge
permission). When the server merges one it tells the page, which shows
"Auto-merged owner/repo#N after checks passed" for the next few minutes. If
Forgejo refuses the merge, the server doesn't ask again until the pull request
changes (a rate limit or an unreachable forge is retried after five minutes),
and the log records each attempt by repo and number. Closing or merging the
pull request elsewhere removes the intent, once Forgejo confirms it. A token
that can push but not merge only finds out at the merge itself.

A merge scheduled in Forgejo's own web UI ("Merge when checks succeed") shows
as auto-merging too, with Cancel auto-merge on it. Forgejo's pull request JSON
has no field for it, so each refresh reads the pull request's timeline (`GET
/repos/{owner}/{repo}/issues/{n}/timeline`): the latest of the
`pull_scheduled_merge` and `pull_cancel_scheduled_merge` events decides. That
is two extra requests per pull request (a page, then the empty page that ends
the read, since Forgejo drops some rows after paging and a cancel can sit on a
later one), so it only runs for open pull requests that aren't drafts or
empty, at most eight per repo per refresh, eight at a time. The ones over the
cap are read on the next refresh, oldest read first, and keep their last known
state until then. A failed read keeps the last known state too and never fails
the refresh. Cancel auto-merge also calls Forgejo's
cancel endpoint (`DELETE /repos/{owner}/{repo}/pulls/{n}/merge`), and treats
"nothing scheduled" (404 or 409) as done.

Each pull request that is auto-merging also carries `autoMergeHeldBy`, so a
client can word it right: `dashboard` when this app holds the intent and merges
itself, `forge` when the merge is scheduled on the forge (Forgejo's scheduled
merge, or GitHub's auto-merge). With both on Forgejo it is `dashboard`, since
this app's loop merges and Cancel clears both. It is absent whenever
`autoMergeEnabled` isn't true, and absent means unknown: don't guess it.

Under a Forgejo repo's heading, when pull requests are grouped, a note says that
Forge Dashboard handles auto-merge there, not Forgejo, and links to the "Forgejo
auto-merge" card in Settings, which explains it in plain words.

Merge, close, auto-merge, Update branch, and the Dependabot and Renovate actions
all report on the row you acted on, not in a banner at the top of the page. A
wait shows as one chip in the row's action area (below), and a failure gets a
status line under the actions: "Failed" with the reason, a Retry button and a
Dismiss button. Each pull request in flight has its own. A failure says one
plain sentence: the server's own reason when it gave one, or "The forge refused
this action and gave no reason." The raw error text stays in the server log, and
off the row. A **Copy** button beside the failure (on the row and in its toast,
and under a failed **Rerun failed checks** in the pipeline panel) copies what
the server really answered, for pasting into a ticket or a chat: one JSON
object with the HTTP status, the response body as it arrived (the raw `error`
included), the action, the pull request's forge, repo and number, and the time.
The button says "Copied" for two seconds. A failure with no answer at all
copies the action's context and the browser's own error. Where the clipboard
can't be written (an insecure page, a refused permission), the same text shows
in a box to select. Retry shows only for a failure that can pass by itself, such
as the forge not answering. The line clears when you dismiss it, when you start
another action on the row, with "Clear finished", or when a refresh shows the
pull request gone.

A toast appears bottom-right when something completes or fails: up to three at a
time, the newest on top, with the `owner/repo#N`, a one-line message, "Show row"
(scrolls to the row and focuses it; if a filter hides the row it clears just
that filter, if the row is on another page it moves there, and if the pull
request is merged or closed it says so) and a dismiss button. Success toasts go
after about six seconds and wait while you hover or focus them. Error toasts
stay until you dismiss them. The sticky "Activity" control keeps a count and
opens a panel of in-flight and recent actions per pull request, with "Show row"
and "Clear finished", so a dismissed toast isn't lost. A reload keeps the
finished entries for as long as the tab stays open, up to 40, until you use
"Clear finished" (they live in the tab's `sessionStorage`; with storage blocked
the list starts empty). A restored failure has no Retry. A request still queued
comes back from the server, which holds it on the pull request until a refresh
shows it landed or the wait runs out. One polite live region announces each
event once and never reads out the countdown, and with reduced motion on, toasts
appear without animation. The banner at the top is left for global conditions
such as a rate limit or an unreachable forge.

The waiting chip is how a row says "something is happening, hold on". It is one
chip in a slot at the top of the row's action area, which every pull request row
always reserves, so a chip coming or going never moves the row. It has an icon,
a bold label of at most three words and a lighter line naming the actor or the
reason. The fuller explanation is a hint that opens on hover and on keyboard
focus (the chip takes focus), and a button shows only where one exists. The
states: `Rebase requested` and then `Rebasing` for a Dependabot or Renovate
`rebase`, `Recreating` for a Dependabot recreate, `Updating branch`, `Merging`
and `Closing` while the forge answers, `Arming` and `Disarming` for auto-merge,
and `Waiting for CI` (or `Waiting for parent`, `Rate limited`, `Waiting for
ready`, `Waiting for forge`) for an armed auto-merge on either forge, with `Disarm`.
Once nothing is left to wait for, Forgejo's reads `Merging next` (this app
merges it on its next refresh, also when the holder is unknown), `Merging` when
the server says Forgejo itself holds the merge (it merges when checks pass),
and GitHub's reads `Merging` (GitHub merges it as soon as it can). Cancel on a
merge Forgejo holds says it cancels the merge scheduled on Forgejo. On GitHub,
Disarm turns GitHub's own auto-merge off with `disablePullRequestAutoMerge`.
When a pull request goes empty, because its branch
landed on the base some other way, the app cancels an armed auto-merge on it
(GitHub's with the same mutation, Forgejo's by dropping its intent) and the
row's `autoMerge` status says "Auto-merge was cancelled: there is nothing left
to merge." for ten minutes. A pull request that is not empty, or not armed, is
never touched. When a request ends well the chip reads `Settled`
for four seconds and goes. A wait with no change for two minutes reads `Still
waiting` with `Check again`, which reads the row from the server now. Each
change is announced once through the polite live region, the ticking age and the
refresh countdown are kept out of it, and nothing is announced when the chip
clears. With reduced motion on, the spinner is a still icon. Icon and words
carry every state, not colour. On a phone the chip fills the card's width
without widening it, and its button is 44px high. The chip's wording lives in
one place, `web/src/lib/wait-chip.ts`. A failure or a timeout is not a wait and
stays a text line with Retry and Dismiss.

Update branch, `Dependabot: Rebase` and `Renovate: Rebase` only ask the forge or
a bot to act, and the result shows up on a later refresh. Update branch turns
into a "Queued…" button the moment you click it. It ignores clicks but keeps
keyboard focus (`aria-disabled`), so you don't lose your place. The row's
`Updating branch` chip says the request went out and counts down to the next
background poll. If the countdown runs out before the refresh lands, it reads
"Refreshing…" instead. An unrelated refresh doesn't clear it. Update branch
clears once a refresh shows the branch caught up. If the request fails, the
button comes back and the row and an error toast say why.

The server keeps the request: a branch update the forge accepted shows up on the
pull request as `updateRequest`, with a phase (`queued` or `expired`), when it
was asked and `expiresAt`. It clears on the first snapshot from a fetch that
started after the request and shows the pull request no longer behind, or when
the pull request is gone, and goes `expired` after five minutes still behind.
Like `botRequest` it is in memory per account, so a server restart forgets it.
The page only draws it: the click shows the `Updating branch` chip at once, and
after that each snapshot decides. A snapshot without the record finishes the row
with a `Settled` chip ("Branch updated"), the `expired` phase ends it with a
timed-out line, an error toast and Retry, and a record the page never clicked (a
reload mid-wait) starts the row with the chip.

A bot `rebase` waits on the bot, not on the dashboard. The request button
goes (a Renovate request leaves its cancel, a Dependabot one nothing), and the
chip reads `Rebase requested` with the bot's name and an age that ticks along,
kept out of what a screen reader announces. Its hint says the bot acts on its
own schedule and that it can take a few minutes. Dependabot is asked with the
`@dependabot rebase` comment and Renovate with the `rebase-check` checkbox in
the pull request body (the `rebase` label when the body has none), and the hint
says which. The request lives on the server: a successful Dependabot or Renovate
request shows up on the pull request as `botRequest`, so a reload mid-wait still
shows the chip, with the age counted from when it was asked. The page only draws
it. When the server moves the request to `rebasing` (the bot pushed, and CI
hasn't restarted), the chip reads `Rebasing`. When the server drops it (CI
showing pending, two minutes after the push, or the pull request leaving), the
chip reads `Settled`, then goes, and a toast says it finished. When the server
marks it `expired` (ten minutes with no sign of the bot), the row says it timed
out, with an error toast and a Retry.

Once a rebase is requested, the pull request offers no second request. While
Renovate's rebase checkbox is ticked, a rebase is already waiting for Renovate,
so the server lists `cancel_renovate_rebase` instead of `renovate_rebase`, and
the row and the pop-up draw `Cancel Renovate rebase` and no `Renovate: Rebase`.
The cancel clears the checkbox in the pull request description
(`POST /api/v1/pull-requests/renovate-rebase/cancel`). The server reads the box
from the description in the same list call (no extra request), so it holds
whether the box was ticked here or on the forge. Renovate clears the box once it
has rebased, and the next snapshot offers the rebase again. If the refresh
after a cancel fails, the row stays without the cancel until a snapshot that
has read the forge arrives, instead of drawing it again from the old one. Once
Renovate is rebasing, the cancel is gone on purpose, even if the box is ticked
again meanwhile: from the description alone that looks the same as a box
Renovate is still consuming, and clearing it would withdraw the wrong request.
A box found already ticked, by a click or by a queued request that was skipped,
is shown as ticked and offers the cancel only while Renovate isn't rebasing.

Two requests have no way back, so they list neither action and the wait chip is
all the row shows: a Renovate rebase asked for with the `rebase` label (there is
no box to clear), and any pending Dependabot command. A Dependabot `rebase` and
`recreate` are both left out of the list while either waits, which also stops
one from being sent over the other. A request that timed out is no longer
pending, so the commands come back.

Dependabot tells you it got a command by reacting to the comment with a
thumbs-up, and it can then take several minutes to push. The server looks for
that reaction on each refresh while a Dependabot `rebase` is waiting, and the
chip's second line changes from "Dependabot" to "Dependabot got it", with one
announcement for screen readers. If no thumbs-up shows after ten minutes the row
says "No reply from Dependabot yet. The command may have been dropped or rate
limited.", and offers `Ask again` (it posts the command once more) and `Open
comment`, a link to the comment on GitHub. A thumbs-up that turns up after that
revives the request. An acknowledgment gets another ten minutes to become a
push. Looking up the reaction needs no extra permission, and if GitHub can't
answer, the chip stays on "Dependabot" and shows no error. Renovate and
`Dependabot: Recreate` have no such signal and read as before.

The server's `botRequest` has these fields: the bot, the action, a phase
(`queued`, `rebasing` or `expired`), when it was asked, `expiresAt` (when the
server stops waiting in that phase) and, for a Dependabot `rebase`,
`acknowledgedAt` (when its thumbs-up was first seen) and `commentUrl`. It moves
along on each snapshot from a fetch that started after the request: a changed
head, or a pull request that was behind and isn't, means the bot pushed. An
expired request goes after an hour. The record is in memory per account, so a
server restart forgets it and a browser reload doesn't. The page shows the
request as queued the moment you click, until the next snapshot says otherwise.

A queued Dependabot request names itself: `Rebase requested` or `Recreate
requested` on the button. While either command is pending the server lists
neither `dependabot_rebase` nor `dependabot_recreate`, so the page draws no
button for the other one. Recreating over a pending rebase would throw its work
away, and rebasing during a pending Recreate is pointless since recreating
rebuilds the whole pull request. Dependabot has no command to withdraw a
request, so Recreate stays held back for the whole wait, on purpose, not only
for a few seconds after the click. The command you just sent keeps its disabled
`requested` button until the server lists the request, so the row never goes
blank. If another tab already sent the same command, the server answers 409
with the `already_requested` code and the page shows the command as requested,
not as a failure. Both commands come back once the bot has acted or the request
has expired.

A Dependabot or Renovate pull request gets no Update branch button: each
has its own `Rebase` action instead (below). A pull request counts as
Renovate's when its author is GitHub's Renovate App (`renovate`,
`renovate[bot]`), is an account named `renovatebot`, or when its head branch
starts with `renovate/`, Renovate's default prefix, whoever the author is. A
Forgejo or GitLab instance can name its Renovate account anything, so if
neither default catches it, list it in Settings under `Renovate logins`
(`renovateAuthors` in the API). Until you do, that account's pull requests
look like a person's. A release-please pull request
does get one, because release-please has no `rebase` command. It only
regenerates its pull request when the release notes change. A release
pull request can therefore fall behind with nothing else to catch it up. When
release-please does regenerate it, it force-pushes the branch, so the
merge commit Update branch adds is overwritten rather than conflicting.

A Dependabot-authored pull request on GitHub instead gets its own pair of
buttons — `Dependabot: Rebase` and `Dependabot: Recreate` — that trigger
Dependabot's own [comment commands](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates#managing-dependabot-pull-requests-with-comment-commands)
(`@dependabot rebase` / `@dependabot recreate`) instead of you switching to
the forge to type them yourself. GitHub only — Dependabot doesn't run on
Forgejo.

On a Bots page row, `Dependabot: Rebase` is the main button and a chevron
beside it, named `More Dependabot actions`, opens a menu with `Dependabot:
Recreate`. The rebase is the common, safe command. Recreate is the heavier
fallback: it rebuilds the pull request and discards any edits made to it, so it
asks first. Choosing it swaps the buttons for `Confirm recreate?` and `Cancel`,
with a line saying what it discards, and only `Confirm recreate?` posts the
comment. Escape, a click elsewhere, `Cancel` and eight seconds without a choice
all cancel it. The pop-up lists `Dependabot: Rebase` and `Dependabot: Recreate`
as separate buttons, and Recreate asks first there too. The menu opens under
the button, so a row on a phone doesn't grow sideways.

Dependabot only honours these commands from a user with push access, and
it ignores GitHub App accounts whatever permissions the App holds
([upstream issue](https://github.com/dependabot/dependabot-core/issues/9147)).
So when you've connected a GitHub App, the commands go out with your saved
personal access token instead, and the comment shows up as you. With an
App and no saved token, both buttons are locked with that explanation
and the background pass below skips Dependabot pull requests, rather than
posting comments Dependabot would only refuse.

A repo with a behind pull request can also be brought up to date without a
click at all, by enabling auto-update-branch for it in Settings. The Update branch
button then stays off that repo's rows, except to flag a conflict and on a
release-please pull request (the pass skips those). The "behind" reason on Merge
says whether the app or you update the branch. For a
Dependabot pull request specifically, that background pass drives the same `@dependabot
rebase` command the manual button does rather than a generic branch update
— and if that `rebase` leaves the pull request's CI failing, follows up with
`@dependabot recreate` on its own, the same way you'd notice the failure
and click Recreate yourself. A Renovate pull request gets the same
treatment as the manual `Renovate: Rebase` button below it — the
body's `rebase-check` checkbox ticked (or the configured `rebase` label when the
body has none) instead of a generic branch update, since that's Renovate's
own rebase/retry trigger, not a comment command.
The background pass always skips release-please pull requests, so nothing
writes to a release branch unattended. The manual Update branch button is
the way to catch one up. A generic update the forge refuses, such as a merge
conflict, isn't tried again until the pull request changes or an hour passes,
and any other failure waits five minutes, so a stuck pull request costs one
request, not one per refresh.

The pass has a budget of its own. A refresh waits 30 seconds for the update and
auto-merge calls that follow it, then moves on and cancels the call still in
flight, so a forge that hangs on them can't hold the board at old rows. The
cancelled pass stops there: only the pull request whose call was in flight takes
the five-minute wait, and a cut-off merge shows no failure, since the forge never
answered. The pull requests it hadn't reached are tried on the next refresh.
Only one pass runs at a time. A refresh, or a webhook that brings a passed check,
that finds one still going doesn't lose its writes: they run as soon as it ends,
with a budget of their own. Only the newest waiting snapshot is kept, and the
log says so once, as a warning that names how many it stood in for.

Cancelling relies on the forge client giving up when its context does, as the
HTTP client does. A client that ignores its context keeps the single slot past
the budget, so the queued writes start late and from a snapshot that could
already be stale. The next refresh still publishes, since it doesn't wait for
the slot.

A repo can also rebase only its bot pull requests. Switch on rebase bots for
it on the Webhooks page, beside Auto-update, and the background pass sends a
behind Dependabot or Renovate pull request its own rebase, the same
`@dependabot rebase` comment or Renovate rebase label as above, never a generic
branch update. Human, draft and release-please pull requests are left alone.
With both switches on, the rebase-bots switch decides a behind bot pull
request. With only Auto-update on, nothing changes. A choice made on a single
pull request still wins: a bot pull request switched off stays put. The
setting is off by default. `POST /api/v1/repos/rebase-bots/enable` and
`/disable` set it, and `rebaseBots` on each repo in `GET /api/v1/dashboard`
reports it. With a GitHub App and no saved personal access token the switch is
locked, for the same reason the Dependabot buttons are. The lock covers the
whole switch, so Renovate pull requests wait too.

Each pull request can also have its own say, whatever its repo does. Every
pull request in `GET /api/v1/dashboard` carries its own state under
`autoUpdate`: whether the pass updates it (`enabled`), where that comes from
(`source` is `repo` for the repo's setting and `pullRequest` for a choice made
on this one), and, for a draft or a release-please pull request, the reason
under `unavailable`, because the pass never touches those however they are
switched.
`POST /api/v1/pull-requests/auto-update` with `enabled` true or false sets it,
so a pull request you are still testing stays put while the rest of the repo
keeps updating, or the other way round for one pull request in a repo that
doesn't update by itself. The dashboard only keeps a choice while it differs
from the repo's setting: choosing what the repo already says, or sending
`enabled` as `null`, hands the pull request back to the repo, so a later
change to the repo's setting reaches it. That includes the repo being
switched to match a choice made earlier: the pull request follows the repo
from then on. The choice is forgotten as soon as the pull request is merged
or closed, so one that reopens follows its repo again. It is also forgotten
once the pull request is no longer open or its repo is no longer tracked, and
a pull request the dashboard doesn't hold is refused. Update branch comes
back on a pull request you have switched off, and goes away on one you have
switched on.

An agent sets the same choice with the `set_pull_request_auto_update` MCP tool,
which takes `forge`, `fullName`, `number` and `enabled`. It does what the
endpoint does, answers the same refusals, and writes only this app's own
setting, so it sends nothing to a forge. Read the effective value and its
source back from `autoUpdate` on the pull request in `get_dashboard`.

In the details pop-up this is the checkbox "Update this branch
automatically", just before the buttons. It shows the effective value, and the line
under it says whether that is the repo's setting or a choice made for this
pull request. Changing it saves at once. "Use the repo's setting"
appears only while the pull request has a choice of its own. On a draft or a
release-please pull request the box is greyed but still reachable by keyboard,
and the line under it gives the reason. A row carries a small "Auto-update on"
or "Auto-update off" marker only where the choice is the pull request's own.

A Renovate-authored pull request, on either forge, gets a `Renovate:
Rebase` button that ticks the `rebase-check` checkbox in the pull request's
body, which every Renovate pull request carries and which needs no setup on
the repo. Renovate doesn't read comments as commands, so the checkbox and a
label are its only rebase/retry triggers. The dashboard edits that one
character and leaves the rest of the body alone. If the box is already
ticked the button answers `already_requested` and changes nothing. A body
with no checkbox falls back to adding the configured `rebase` label
(Settings' own `Renovate rebase label` field, described earlier). On Forgejo
that label has to already exist on the repo (its labels API takes an
existing label's ID, not an arbitrary name); the button reports that plainly
instead of silently doing nothing if it doesn't.

On a pull request with any CI reported, the CI pill is a button that opens
a panel listing every individual job/check against its head commit —
status, name, and a link to that job's own page on the forge — instead of
only the pill's own summary. (Filtering by CI state is the quick pills' job.)
Fetched fresh every time the panel opens, not cached, or part of the regular
dashboard refresh. Falls back to the legacy combined commit-status
API's own per-check entries when a repo (or an older Forgejo instance)
reports no Actions/Workflow runs at all for that commit.

While a pipeline is running, the pill also says how far it is: the word
Running, then a count for each state that has any, in the order passed, running,
waiting, failed, each with its own glyph. A state with no checks is left out. On
a phone the word goes and the counts stay. The server tallies the counts from
what it already reads to work out the CI state, so on GitHub they cost no extra
request, and a pull request that has none keeps the plain pill. A run held for
approval and a cancelled run are in none of the four, because the CI state
doesn't treat them as failures while others still run. On Forgejo the
statuses only say pending, so when any are pending the server also reads the
jobs of the runs on the commit that are running (one call for the runs, one
for each of them, read side by side, at most eight at once), and the jobs in
progress show as running. A queued or blocked run isn't read, a running pull
request run (any `pull_request` event) leaves the running push run out so no job
counts twice, and a commit with no pending check makes no extra call. Runs are
matched to the commit ignoring the case of its SHA.

A pull request whose only trouble is a cancelled job reads Cancelled while its
pipeline panel is open, the same word and grey pill a main branch uses and the
word the panel gives the job. The servers don't agree on that run. GitHub's
combined state calls it failed, and Forgejo leaves cancelled jobs out of the
failed count, so the row reads No checks or Passed. The page folds the jobs the
panel lists the way a branch does, and the row follows the panel: a cancelled
job beside one still going is Running, beside a real failure it is Failed, and
beside passed jobs alone it is Cancelled, with no counts. Close the panel and
the row goes back to what the server sent.

On GitHub, the pill stays pending while a check that branch protection or a
ruleset requires hasn't finished. GitHub's combined status only counts checks
that exist, and can read as passed for a moment after a push while the rest of
the pipeline is still queued, so a pull request with one of five required
checks reported would read as passed. A required check that is queued or
running counts as not finished. The server looks the required checks up only
when the combined status says success and GitHub still blocks the pull request.

Reading which checks are required needs admin on the repository for classic
branch protection. Without it, the server can't tell a required check that
hasn't started from one that passed, so it falls back to what GitHub reports on
the pull request itself. A pull request whose combined status is success and
whose merge state is `BLOCKED`, that isn't a draft and has no review
outstanding (`REVIEW_REQUIRED` or `CHANGES_REQUESTED`), reads pending: a
required check is the only thing left that can block it. This needs no extra
request. Where the required checks can be read, they decide and the fallback
isn't used. The limit: GitHub also reports `BLOCKED` for a merge queue, code
owners whose review shows no decision, and unresolved conversations. Such a
pull request reads pending, not passed, until GitHub stops blocking it. The
next refresh asks again, so the pill follows GitHub as soon as the merge state
changes.

Just after a push, a response from GitHub can briefly show the new head beside
the finished checks of the previous commit. The server reads the id of the
commit the checks belong to, and when it isn't the head of the pull request the
pill stays pending until they agree.

A check that failed or timed out, and has an excerpt or a job to read, also
has a `Copy log` button under it. A cancelled check doesn't. The button copies
the whole log of the job, or the last 256 KB of it when the log is longer, and
the excerpt alone when the log can't be read; the status line beside the button
says which of these it copied. A log the forge doesn't send within 30 seconds
counts as one that can't be read. Pressing the button again within a minute
reuses the log it read; after that it reads the log again, since a read just
after a job finished can miss lines. Where the browser refuses every way of copying,
the log is put in a text field, selected, for the
person to copy with Ctrl+C (Cmd+C on a Mac).

On GitHub, each failed Actions job also carries how long it ran, the step that
failed and an excerpt: the last lines of its log as plain text, with
timestamps and colour codes removed, capped at 2,000 characters. Those cost up
to three extra requests per failed job (at most five jobs), made only when the
panel opens. A check that isn't an Actions job, or a log the token can't read
or that has expired, shows without them and keeps its link.

On Forgejo, a failed job carries the same kind of excerpt, but no steps and no
timing, since its API doesn't serve them. The checks list reads no log, so it
answers at the speed of the forge's job list, and a failed check shows at once
with its link. The panel then asks for the excerpts of the newest five failed
jobs, one after another, and fills each in as it lands, announcing it politely
to a screen reader ("Log excerpt loaded for test."). That is one request per
failed job (retries come out of the same five), each given 15 seconds, made only
when the panel is open and the person is about to look at the check, through
`GET /api/v1/checks/log` with `excerpt=true`. A log with text is read once per
finished job and kept, so a branch that stays red costs no more reads. A log
that can't be read, or that is missing, is not asked for again for a minute, and
an empty log, which is usually one the runner has not flushed yet, for ten
seconds. A read that comes back empty is asked for again by the panel after 15
seconds, at most twice more, while it stays open, so the excerpt of a job that
just failed appears when its log lands. A read that failed is not asked for
again by the panel, since the server would answer it with nothing for the
minute. A job with no log address shows without an excerpt and costs no read;
the other jobs still get theirs. A token that is refused, or a forge that limits
requests, stops the rest of the panel's reads and every retry. The five reads
are a budget for one time the panel is open, and the retries spend from it: each
job's first read and each retry takes one of the five, so an open never makes a
sixth read, and with five failed jobs there is no room left to retry. A failed
job that appears later takes only the places left, and a rerun of a job already
read takes a place of its own. An excerpt of a job with no finish time is kept
for a minute only. Whether a log has settled is judged by comparing the forge's
finish time with this machine's clock, so the two are assumed to agree to within
the settle delay of 30 seconds. A job whose log can't be read keeps its link and
shows without an excerpt. A Forgejo too old to serve job logs answers those
reads with a bare 404 that carries none of its own error body; the request log
records that as an error rather than as a pruned log, so the gap stays visible
there. The API stats page counts requests only and doesn't show outcomes.

A pull request whose CI is failing also offers `Rerun failed checks` at the top
of that panel, on GitHub and on Forgejo. It reruns only the failed jobs of each
workflow run on the head commit, and a job that passed isn't started again. On
Forgejo 17 and later that takes one extra read per failed run to list its jobs,
then one request per failed job. Forgejo restarts the jobs that need a rerun
job along with it, so a job that passed but waits on a failed one goes again
too. It answers when the forge has queued them: the panel says "Rerun queued"
and the new results show after the next refresh. The button stays pending and
reads "Rerun queued", in the panel and in
the pull request's detail view, until the pull request stops reading failed, is
updated, or ten minutes pass, so the same rerun can't be queued twice. A
refused rerun isn't held and leaves its failure line in the detail view. It
needs write access to Actions: the `repo` scope on a classic
token, Actions (read and write) on a fine-grained token, or Actions (Read and
write) on a GitHub App. A permission added to an App that is already installed
does nothing until the owner accepts it on the installation's page. When the
forge refuses (no permission, a run too old or already running), the panel shows
its reason and the button stays for another try.
A failed check that isn't an Actions job, such as an external CI, can't be
rerun and is skipped; a pull request with nothing left to rerun answers "no
failed job to rerun" (`POST /api/v1/pull-requests/rerun-checks`, listed as
`rerun_checks` in `allowedActions`).

Forgejo added the rerun routes in version 17. Versions 7 to 16 have none,
so on those the dashboard reads the instance's version in the background on its
first refresh and draws no button: the button in the details dialog is disabled
and the panel prints "This Forgejo is older than version 17 and has no way to
rerun checks. Rerun them on the forge." No rerun request is sent to the forge,
and the version is checked before the pull request or its runs are looked up,
so a missing route is the reason you see and not "no failed job to rerun". An
answer that blocks is read again after an hour, and a click reads it again at
once when it has gone stale, so an upgraded instance works without a restart.
When the version can't be read, or isn't a number, it is tried again after
half a minute, the button is drawn and the forge decides. A version below 7 is
left to the forge too, because a Gitea numbers itself that way. Where the forge
decides, a 404 can mean the route doesn't exist there or that the run is gone
or the token can't see the repository, so the panel names neither a forge nor
a version: "The forge couldn't find that run, job or pull request. It may not
support rerunning checks from here, or the token can't see this repository." On
a default branch, where no pull request is looked up, the sentence reads "run or
job". A block that has gone stale is lifted if the read fails, not kept.

Forgejo restarts one job per request, so a refusal can come after earlier jobs
already went. The panel then says which: for example "Restarted build. Did not
restart test, lint and the failed jobs of 1 other run." Rerunning again starts
only what is still failed. When the jobs can't be read again after a restart,
the panel can't say which others went, so it says they may have restarted with
the one that did. When a request gets no answer at all, the forge may have
queued that job and the others that need it. That covers a timeout, a reset, a
handshake that timed out, a cancelled wait, a gateway error (502, 503 or 504)
and a success whose body couldn't be read: anything else with no clear answer
counts as possibly restarted. The panel then says that job may have restarted,
and so may the other failed jobs of its run, instead of listing them as not
restarted. This holds for the first job too. Only a request that provably never
reached the forge (a refused connection or proxy, a name that doesn't resolve,
a rejected certificate) did nothing and is listed as not restarted. The panel
leaves out "Try again in a moment" beside such a note, since jobs may already
be running, whether the forge went quiet or answered with a gateway or server
error. When nothing could have restarted, such as a refused connection, the
advice stays: "The forge didn't answer. Try again in a moment. Restarted build.
Did not restart test." A refusal of the first job says nothing of the kind,
because nothing restarted.

`rerun_checks` still appears in `allowedActions` for a blocked
Forgejo. The block shows in the forge's health as `rerunChecksBlocked`, and a
click answers 409 with the same sentence. The block is per forge kind: with a
Forgejo 16 and a Forgejo 17 configured side by side, the button stays until
both lack the route, and the 409 answers a click on the older one.

While a pull request has a check running or waiting, even beside one that
already failed, the same panel offers `Cancel run: <workflow>` for each workflow
run that still has a queued or running job, on GitHub and on Forgejo. With
more than one such run, each button names its run: the workflow, plus the
forge's run number (`Cancel run: ci #614`) when two runs share a workflow or a
run has no name. A lone run whose forge gave no name reads plain `Cancel run`.
On Forgejo a queued run (`waiting`, `blocked` or `unknown`) counts too, even
before it has any job: it appears as one check named for its workflow, so a push
that queued many runs can be stopped from the panel. A finished run is never
offered.
Neither forge can stop one job of a running workflow, so the unit is the run:
the confirm step names the whole run and the unfinished jobs that stop with it
(a Forgejo run whose jobs can't be read says it stops everything still going in
it), and nothing is sent until you press `Yes, cancel run`. `Keep running` sends
nothing. When the forge accepts, the panel says "Cancelling" and reads the
checks again every few seconds until the run has stopped, then says it was
cancelled. If the run is still going after eight reads, the panel says so, and
the button comes back; if no read came back, it says it couldn't check. When the
forge refuses (the token can't write to Actions, the run already finished, a
Forgejo too old to have the cancel route, a rate limit), the panel shows the
forge's own reason and draws no button for that run. A refused permission also
removes the button from every run of that repository for five minutes, so a
fixed token works without a reload. It needs the same write access to Actions as
the rerun. A job that isn't an Actions job, such as an external CI, belongs to
no run and has no button, though a pull request with only an external CI running
still lists `cancel_run`, since the list can't tell the two apart. A Forgejo
external CI that reports a pending commit status counts the same way. A Forgejo
too old to have the cancel route answers with a 404, which reads the same as a
run that is gone, so the panel shows that reason and doesn't lock. A cancel is
never queued for a rate-limit reset: by then the run may be a different one,
started by a newer push, and a cancel can't be undone (`POST
/api/v1/checks/cancel-run` with `{forge, fullName, runId}`, listed as
`cancel_run` in `allowedActions`).
A job of a workflow run carries that run, so a finished job says which run it
came from. On GitHub the run's id is in the job's page address and costs
nothing. Its name and number come from the runs for that commit, which the checks
list reads extra. While some check is running or queued it reads the queued workflow
runs, the running ones, and the jobs of each: three reads for a commit with one
active run, and the same three again on every re-read after a cancel. When a
finished job names a run those reads didn't list, it also reads the completed
runs for that commit, once however many jobs there are. So a finished GitHub pipeline
costs one extra read each time its list is read, and a pipeline with a running
check costs up to four. A failed lookup leaves the run's name and number empty
and the list intact, and the run id still lets the panel offer the cancel. The
panel doesn't claim a run has finished or stopped until it sees the run's own
jobs finish.

When the forge says which checks the base branch's protection requires,
the panel groups them: a `Required` group first, with a failing required
check flagged `Blocking`, then `Advisory`. GitHub's classic required
status checks and its rulesets are both read, and Forgejo's
`status_check_contexts` patterns. Reading branch protection needs more
permission than listing checks (admin on GitHub's classic rules and on
Forgejo), so with a token that can't, or for a check the dashboard can't
match to a protection entry, the check lands under `Status unknown`
rather than being guessed advisory (the pill has its own fallback, above). A
Forgejo Actions job is only marked required when a pattern matches its job
name or its workflow-file context; it is never marked advisory. If nothing is
known for any check, the panel stays the flat list.

Each check's state has its own glyph inside a tinted pill, so states differ
by shape and word, not colour alone. Passed is a check in a circle, Failed and
Timed out a cross, Running an amber spinning arc (a still clock under reduced
motion), Queued an hourglass in a dashed blue ring, Waiting for approval a pause
sign in a ring (the row's pill draws the same one), Skipped a slashed circle in
the quietest weight, and Cancelled a stop square in a circle.

## Asking every out-of-date bot to catch up

The Bots page header has a `Rebase all` button for the whole list. It counts
the pull requests the filters leave that are behind their base and offer a
rebase, so `Rebase all (6)` means six, and a filter that narrows the list
narrows the count. A line beside it says how many of the listed pull requests
are out of date, for example `6 of 9 are out of date.`

Pressing it opens a confirm dialog that lists each pull request with its forge.
`Rebase` then asks the bots one pull request after another, through the same
`Dependabot: Rebase` and `Renovate: Rebase` actions the rows use, so nothing is
pushed by the dashboard. The button reads `Rebasing 3 of 6` as it goes. A
request the forge refuses shows its reason on its own row, with that row's
retry, and the others carry on.

A pull request that is empty, already has a rebase requested, or has no rebase
to offer isn't counted. When no pull request can be asked, the button is
disabled. A Dependabot pull request on a GitHub App with no saved personal
token is left out too, and the line gives the reason.

The button and its line show only while a listed pull request is out of date.
When none is, because they're all current or a filter hides the ones that
aren't, both go away, and focus moves to the `All` quick filter if the button
had it. A run that's under way keeps the button until it ends.

## Updating every out-of-date pull request

The Pull requests page header has the `Update all` button, where the Bots page
has `Rebase all`. It counts the pull requests the filters leave whose `Update
branch` action the server offers and doesn't block, so `Update all (4)` means
four, and a filter that narrows the list narrows the count. A line beside it
says how many of the listed pull requests are out of date, for example `4 of 6
are out of date.` Bots have their own page and aren't listed here.

A pull request that the dashboard already updates by itself isn't counted,
listed or updated: one in a repo with automatic branch updates switched on, or
one switched on for itself. One switched off for itself, or one a draft or
release-please pull request keeps out of the automatic update, still counts.

Pressing it opens a confirm dialog with a tick box for each pull request, all
ticked. Clear a box to leave that one out. `Update` then updates the ticked ones
one after another, through the same request the row's `Update branch` sends. The
dialog closes as soon as you press `Update`, and focus returns to the button.
The button reads `Updating 2 of 4` as it goes. No request waits on a board
refresh. The board refreshes once, when the last one has been sent. An update
the forge refuses shows its reason on its own row and the others carry on. A
screen reader hears `Update requested for 4.` when the run ends, or `Update
requested for 3 of 4. 1 failed.`

Escape, or `Close`, before `Update` updates nothing.

The button and its line show only while a listed pull request can be updated.
When none can, because they're all current or a filter hides the ones that
aren't, both go away, and focus moves to the `All` quick filter if the button
had it. A run that's under way keeps the button until it ends.

## Deleting the source branch on merge

`POST /api/v1/pull-requests/merge` can also delete the branch the pull request
came from. Send `deleteBranch: true` with the usual `forge`, `fullName` and
`number`. Without it, or with `false`, nothing changes: the answer is `204` and
the branch stays.

The branch is deleted after the merge succeeds, and never before. With
`deleteBranch` set, the answer is `200` and says what happened to the branch:

```json
{ "branchDeletion": { "outcome": "skipped", "reason": "protected" } }
```

`outcome` is one of:

- `deleted`: the branch is gone. A branch the forge had already removed counts.
- `skipped`: the branch was left alone on purpose. `reason` is `fork` (the
  branch lives in another repository), `default_branch`, `protected`,
  `in_use` (another open pull request in the repository has the branch as its
  head or base, such as a stacked pull request that targets it), or
  `unsupported` (the forge's client can't delete branches).
- `failed`: the forge refused or couldn't be reached.

A skipped or failed deletion never turns a merge into a failure. The pull
request is merged either way, so the caller reads `branchDeletion` to decide
what to tell the person. Auto-merge doesn't delete branches.
