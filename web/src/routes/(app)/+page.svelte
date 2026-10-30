<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { FORGE_CLASSES, FORGE_LABELS } from "#lib/forges.js";
  import { pipelineTarget } from "#lib/pipeline-target.js";
  import { runSignature } from "#lib/pipeline-live.js";
  import type { Check } from "#lib/pipeline-checks.js";
  import { splitStaleRows } from "#lib/forge-starting.js";
  import { ciPillModel, renderCiPill } from "#lib/ci-pill.js";
  import { createBranchRerun } from "#lib/branch-rerun.js";
  import { createRedrawGuard } from "#lib/redraw-guard.js";
  import { forgeLockReason, rerunBlockedLock } from "#lib/forge-lock.js";
  import { formatTime } from "#lib/time.svelte.js";
  import {
    branchesAwaitingFlag,
    firstRefreshJustFinished,
    firstRefreshLoading,
    firstRefreshPending,
  } from "#lib/first-refresh.js";
  import { firstRefresh } from "#lib/first-refresh.svelte.js";
  import { setBranchNavCount } from "#lib/nav-counts.svelte.js";
  import AdvisoriesDialog from "#lib/AdvisoriesDialog.svelte";
  import PipelineDialog from "#lib/PipelineDialog.svelte";
  import PullRequestDetailsDialog from "#lib/PullRequestDetailsDialog.svelte";
  import FirstRefreshStatus from "#lib/FirstRefreshStatus.svelte";
  import ListSkeleton from "#lib/ListSkeleton.svelte";
  import {
    applyServerState,
    currentPage,
    hasTouched,
    leavePage,
    loadState,
    readCookieState,
    touchKey,
    loadStateFromServer,
    saveState,
    type SharedFilterState,
  } from "#lib/filters.js";
  import {
    ago,
    applyFilter,
    isStale,
    sortMainBranches,
    DEFAULT_FILTER,
    duration,
    forgeCounts,
    offeredForges,
    offeredStatuses,
    isFiltered,
    filterFromState,
    filterToState,
    httpHref,
    advisoryPill,
    advisoryCoverage,
    advisoryCounts,
    offeredAdvisories,
    type AdvisoryFilter,
    advisoryUnknownReason,
    advisoryReasonNeedsGrant,
    advisoryRowUnreadable,
    forgejoAdvisoryReasonText,
    advisoryRowHint,
    ADVISORY_REASON_TEXT,
    type MainBranch,
    type MainBranches,
    type MainBranchFilter,
    branchNavCount,
    branchKey,
    type BranchPill,
    countMainBranches,
    CI_SLOT,
    SEGMENTED_STATUSES,
    STATUS_LABEL,
    statusCount,
    type StatusPill,
    type ForgeFilter,
    rowsToWatch,
    supersedes,
    withLiveJobs,
    withSnapshotRuns,
  } from "#lib/main-branches.js";
  import { followMainBranchPage } from "#lib/main-branch-stream.js";
  import { checkFeed } from "#lib/check-feed.js";
  import { createRowWatcher } from "#lib/row-watcher.js";

  let data = $state<MainBranches | null>(null);
  let failed = $state(false);
  // The rerun control could not be redrawn on the last poll.
  let redrawFailed = $state(false);
  let loading = $state(true);
  let filter = $state<MainBranchFilter>({ ...DEFAULT_FILTER });
  let pipeline = $state<PipelineDialog>();
  let advisories = $state<AdvisoriesDialog>();
  // The branch whose dialog is open, to follow its row from each refresh.
  let openRow: MainBranch | null = null;
  const rerun = createBranchRerun();
  const REDRAW_NOTE =
    "The rerun control could not be updated, so it may be out of date. Reload the page if it looks wrong.";
  // The same note inside the open dialog, where a screen reader user is; the
  // page behind it is inert. Always mounted, so filling it is announced.
  let dialogNote: HTMLElement | null = null;
  $effect(() => {
    // Read first, so the effect depends on it even while no dialog is open.
    const failed = redrawFailed;
    if (!dialogNote) return;
    dialogNote.hidden = !failed;
    dialogNote.textContent = failed ? REDRAW_NOTE : "";
  });
  const redrawGuard = createRedrawGuard((err) =>
    console.error("The rerun control could not be redrawn", err),
  );

  // The server's first refresh after a restart has not finished (#1672): the
  // list is empty because nothing is read yet, not because nothing is tracked.
  const pending = $derived(firstRefreshLoading(firstRefresh));
  // The same list, kept as state so the open row is read from it: the pill, the
  // chips and the nav pill then fold the one job list the dialog shows.
  let liveChecks = $state<{ key: string; checks: Check[] } | null>(null);
  // The job lists of the rows watched on the stream, by row key (#2885). A new
  // map on every change, since a Map in state does not notice a set.
  let rowChecks = $state<Map<string, Check[]>>(new Map());
  // The dialog's list wins for its row: it is the list the dialog shows.
  const liveLists = $derived(
    liveChecks
      ? new Map(rowChecks).set(liveChecks.key, liveChecks.checks)
      : rowChecks,
  );

  // Sorted by the refresh, then every row with runs is read from them, and each
  // watched row and the open dialog's row from its live jobs: the row keeps its
  // place, and the pill, the chips, the filter and the nav pill all count it
  // one way.
  const refreshed = $derived(
    withSnapshotRuns(sortMainBranches(data?.branches ?? [])),
  );
  const branches = $derived(withLiveJobs(refreshed, liveLists));
  const visible = $derived(applyFilter(branches, filter));
  // The rows to watch are chosen from the snapshot's pills, not the live ones: a
  // row whose live pill left the filter would be let go, read the snapshot
  // again, come back and flap. They are the first rows the page shows, up to
  // the stream's cap less the dialog's slot; the rest keep the snapshot's pill.
  const watchedRows = $derived(rowsToWatch(applyFilter(refreshed, filter)));
  const rowWatcher = createRowWatcher({
    feed: checkFeed,
    onChecks: (key, checks) => {
      rowChecks = new Map(rowChecks).set(key, checks);
    },
    onDrop: (key) => {
      if (!rowChecks.has(key)) return;
      const next = new Map(rowChecks);
      next.delete(key);
      rowChecks = next;
    },
  });
  $effect(() => {
    const wanted = watchedRows;
    untrack(() => rowWatcher.set(wanted));
  });
  const perForge = $derived(forgeCounts(branches));
  // A status or forge pill is offered only when clicking it would show
  // something, and the active one stays (#1427).
  const statusOffered = $derived(offeredStatuses(branches, filter));
  const forgeOffered = $derived(offeredForges(branches, filter));
  const advisoryOffered = $derived(offeredAdvisories(branches, filter));
  const advisoryTally = $derived(advisoryCounts(branches));
  const advisoryState = $derived(advisoryCoverage(branches));
  const advisoryReason = $derived(advisoryUnknownReason(branches));
  const forgejoAdvisoryState = $derived(advisoryCoverage(branches, "forgejo"));
  const forgejoAdvisoryReason = $derived(
    advisoryUnknownReason(branches, "forgejo"),
  );
  const staleSplit = $derived(
    splitStaleRows(branches.filter(isStale), data?.forges),
  );
  const staleRows = $derived(staleSplit.outage);
  const startingRows = $derived(staleSplit.starting);
  const staleSince = $derived(
    staleRows
      .map((b) => b.staleSince)
      .filter((s): s is string => !!s)
      .sort()[0] ?? null,
  );
  // The server sends rows and no tally: the chips below and the nav pill read
  // this one count of them.
  const counts = $derived(countMainBranches(branches));
  const allGreen = $derived(counts.total > 0 && counts.passed === counts.total);
  // The pill in the header is the same tally as the chips below it, and moves
  // with them when the open dialog's jobs do. The write reads the pill's own
  // state, so it is untracked: otherwise it would run again on its own write.
  $effect(() => {
    if (!data || firstRefreshPending(firstRefresh.done)) return;
    const nav = branchNavCount(counts);
    untrack(() => setBranchNavCount(nav));
  });

  const STATUS_PILLS: { key: StatusPill; label: string }[] = [
    { key: "all", label: "All" },
    { key: "failed", label: "Failing" },
    { key: "passed", label: "Passing" },
    { key: "running", label: "Running" },
    { key: "cancelled", label: "Cancelled" },
    { key: "awaiting_approval", label: "Waiting for approval" },
    { key: "none", label: "No pipeline" },
  ];

  const rowKey = branchKey;

  // The row each pill opens the panel for, read when it is clicked, so a pill
  // redrawn in place opens the row as the latest poll left it.
  const pillRows = new WeakMap<HTMLElement, MainBranch>();

  // Redrawn when the branch's status or counts change, which the live refresh
  // brings. The button stays the same node and only its contents change, so a
  // click that a poll lands in the middle of still arrives, and focus, hover and
  // the panel's way back to it need no handing over.
  function drawPill(
    host: HTMLElement,
    b: MainBranch,
    pill: BranchPill,
    slot: { cls: string; glyphs: string },
  ) {
    const model = ciPillModel({
      cls: slot.cls,
      glyph: slot.glyphs,
      word: STATUS_LABEL[pill.status],
      counts: pill.counts,
      segmented: SEGMENTED_STATUSES.has(pill.status),
    });
    const fresh = renderCiPill(model, {
      onOpen: () => {
        const row = pillRows.get(fresh);
        if (row) openPipeline(row, fresh);
      },
    });
    const current = host.firstElementChild;
    if (current instanceof HTMLButtonElement) {
      pillRows.set(current, b);
      current.className = fresh.className;
      current.setAttribute(
        "aria-label",
        fresh.getAttribute("aria-label") ?? "",
      );
      current.replaceChildren(...fresh.childNodes);
      return;
    }
    // The first draw: the fresh button stays, and opens its own row.
    pillRows.set(fresh, b);
    host.replaceChildren(fresh);
  }

  // The open dialog's checks, as the stream last sent them.
  let dialogChecks: Check[] = [];

  // The newest copy of a row, since the dialog outlives the polls.
  const latest = (b: MainBranch) =>
    data?.branches.find(
      (x) => x.forge === b.forge && x.fullName === b.fullName,
    ) ?? b;

  // What a queued rerun waits to see move: the branch's commit or run, or any
  // check's run, attempt or outcome.
  const branchSignature = (b: MainBranch) =>
    [b.commit?.sha ?? "", b.runUrl ?? "", runSignature(dialogChecks)].join("|");

  function openPipeline(b: MainBranch, opener: HTMLElement) {
    openRow = b;
    pipeline?.open({
      ...pipelineTarget({
        forge: b.forge,
        fullName: b.fullName,
        branch: b.branch,
        runUrl: b.runUrl,
      }),
      // A branch has no allowed-actions list: Cancel run is offered for each
      // run the checks name as going.
      cancel: { forge: b.forge, fullName: b.fullName },
      controls: (failed, checks) => {
        dialogChecks = checks;
        liveChecks = { key: rowKey(b), checks };
        if (!failed || !openRow) return null;
        const wrap = document.createElement("div");
        const note = document.createElement("p");
        note.className = "rerun-redraw-note";
        note.setAttribute("role", "status");
        note.dataset.testid = "rerun-redraw-note-dialog";
        note.hidden = !redrawFailed;
        note.textContent = redrawFailed ? REDRAW_NOTE : "";
        dialogNote = note;
        wrap.append(
          rerun.control(
            openRow,
            () => branchSignature(latest(openRow ?? b)),
            () =>
              forgeLockReason(data?.forges, b.forge) ??
              rerunBlockedLock(data?.forges, b.forge),
          ),
          note,
        );
        return wrap;
      },
      opener,
      onClose: () => {
        openRow = null;
        dialogNote = null;
        liveChecks = null;
      },
    });
  }

  // The same dialog the Releases page uses, here fed a published release: it
  // reads the title and notes by tag when it opens.
  let releaseDialog = $state<PullRequestDetailsDialog>();
  const releaseTriggerId = (b: MainBranch) =>
    `release-trigger-${rowKey(b).replace(/[^A-Za-z0-9_-]/g, "-")}`;

  function openRelease(b: MainBranch) {
    const release = b.latestRelease;
    const url = release ? httpHref(release.url) : null;
    if (!release || !url) return;
    releaseDialog?.setChrome({
      status: null,
      feedback: null,
      option: null,
      actions: [],
    });
    releaseDialog?.open(
      {
        subject: "release",
        forge: b.forge,
        repo: b.fullName,
        tag: release.tag,
        title: release.tag,
        url,
      },
      releaseTriggerId(b),
    );
  }

  // Takes a page of rows, from the stream or from the fallback read.
  function apply(next: MainBranches) {
    if (!supersedes(next, data)) return;
    data = next;
    failed = false;
    redrawOpenControl();
  }

  // The forge may have gone down, or come back, since the last page; a failed
  // read still moves the clock. A control that can't draw must not fail the
  // page, but a lock left on screen from the last draw should not go
  // unexplained.
  function redrawOpenControl() {
    redrawFailed = redrawGuard.run(() => {
      if (openRow) rerun.redraw(openRow);
    });
  }

  // The one read of GET /api/v1/main-branches: the first draw, and the fallback
  // when the stream is down. Every update after that comes from the stream.
  async function load(initial = false) {
    try {
      const res = await fetch("/api/v1/main-branches", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      apply((await res.json()) as MainBranches);
    } catch {
      // A refresh that fails keeps the rows already on screen.
      if (initial || !data) failed = true;
      redrawOpenControl();
    } finally {
      loading = false;
    }
  }

  function retry() {
    failed = false;
    loading = true;
    load(true);
  }

  // The filter is saved with the other pages' (#1620): the cookie at once for
  // the first paint, the server copy for another browser. The search box is
  // free text, so it takes the debounced path the other pages' title boxes use.
  let page = -1;
  onDestroy(() => {
    rowWatcher.stop();
    leavePage(page);
    setBranchNavCount(null);
  });
  let saved: SharedFilterState = {
    shared: {},
    pr: {},
    issue: {},
    view: {},
    branches: {},
  };
  // The key is touched before the save, so a server copy still loading does
  // not overwrite it (#1713).
  function save(keys: string[], freeText = false) {
    for (const key of keys) touchKey("branches", key);
    // Another tab may have saved its own filters since this page loaded; the
    // cookie is shared, so start from it and change only this page's group.
    if (document.cookie.includes("forge-board-filters="))
      saved = { ...readCookieState(), branches: {} };
    saved.branches = filterToState(filter);
    saveState(saved, freeText ? "title" : undefined);
  }
  function setStatus(status: StatusPill) {
    filter.status = status;
    save(["status"]);
  }
  function setForge(forge: ForgeFilter) {
    filter.forge = forge;
    save(["forge"]);
  }
  function setAdvisories(advisories: AdvisoryFilter) {
    filter.advisories = advisories;
    save(["advisories"]);
  }
  function setQuery(event: Event) {
    filter.query = (event.currentTarget as HTMLInputElement).value;
    save(["query"], true);
  }
  function reset() {
    filter = { ...DEFAULT_FILTER };
    save(["status", "forge", "advisories", "query"]);
  }

  function listed(b: MainBranch): string {
    const names = b.failingJobs.slice(0, 2).join(", ");
    const more = b.failingJobs.length - 2;
    return more > 0 ? `${names} +${more} more` : names;
  }

  function commitText(c: NonNullable<MainBranch["commit"]>): string {
    return c.author ? `${c.subject} by ${c.author}` : c.subject;
  }
  function noRunText(b: MainBranch): string {
    const last = ago(b.commit?.committedAt ?? null);
    return last
      ? `No run was found for this branch. Last commit ${last}.`
      : "No run was found for this branch.";
  }
  function whenText(b: MainBranch): string {
    if (b.status === "running") {
      const since = ago(b.commit?.committedAt ?? null);
      return since ? `Running, commit made ${since}` : "Running";
    }
    const took = duration(b.durationSeconds);
    return took ? `${ago(b.finishedAt)} (ran ${took})` : ago(b.finishedAt);
  }

  // Read again when the first refresh finishes, instead of showing the empty
  // list until the next poll (#1729). A failed read keeps the rows on screen.
  let lastDone: boolean | undefined;
  $effect(() => {
    const done = firstRefresh.done;
    if (firstRefreshJustFinished(lastDone, done)) untrack(() => load());
    lastDone = done;
  });

  onMount(() => {
    saved = loadState();
    filter = filterFromState(saved.branches);
    page = currentPage();
    // The cookie painted the page; the server copy is what a second browser
    // sees, and it wins as it does on the other pages (#353).
    loadStateFromServer().then((got) => {
      if (page !== currentPage() || !got) return;
      applyServerState(saved, got);
      filter = filterFromState(saved.branches);
      // An edit made while the copy loaded went out on top of the cookie's
      // values; save the merged state so the server keeps the rest too.
      if (hasTouched()) saveState(saved);
    });
    load(true);
    return followMainBranchPage({
      onPage: apply,
      onDown: () => load(),
      onUp: () => load(),
    });
  });
</script>

<svelte:head>
  <title>Main branches — Forge Board</title>
  <meta
    name="description"
    content="The CI status of every tracked repository's default branch, newest commit first."
  />
  <style>
    .mb-wrap {
      max-width: 1220px;
      margin: 0 auto;
      padding: 24px 0 64px;
    }
    .mb-header h1 {
      font-size: 22px;
      margin: 0 0 4px;
    }
    .mb-loading {
      font-size: 13.5px;
      color: var(--ink-2);
      margin: 0 0 16px;
    }
    .mb-banner,
    .mb-note {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 12px 14px;
      margin: 0 0 16px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: var(--radius);
      background: var(--surface);
      font-size: 13.5px;
    }
    .mb-banner {
      border-left-color: var(--warning);
      background: var(--warning-bg);
    }
    /* An author display: flex beats the UA's [hidden] { display: none }. */
    .mb-banner[hidden] {
      display: none;
    }
    .mb-note.good {
      border-left-color: var(--good);
    }
    .mb-note p,
    .mb-banner p {
      margin: 0;
    }
    .mb-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 16px;
      align-items: center;
      padding: 10px 12px;
      margin-bottom: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .mb-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .mb-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 36px;
      padding: 0 12px;
      font: inherit;
      font-size: 13px;
      color: var(--ink);
      background: var(--surface-sunken);
      border: 1px solid var(--border);
      border-radius: 999px;
      cursor: pointer;
    }
    .mb-pill:hover {
      border-color: var(--border-strong);
    }
    .mb-pill[aria-pressed="true"] {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }
    .mb-pill:focus-visible,
    .mb-toggle:focus-visible,
    .mb-search:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .mb-left-out {
      align-self: center;
      font-size: 12px;
      color: var(--ink-muted);
    }
    .mb-count {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }
    .mb-search {
      flex: 1 1 220px;
      min-width: 0;
      min-height: 36px;
      padding: 0 12px;
      font: inherit;
      font-size: 13px;
      color: var(--ink);
      background: var(--surface-sunken);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    /* The placeholder rows sit on a card, as on the list pages: the bars are
       the neutral fill, which is the page background itself in the light
       scheme and would not show on it. */
    .mb-wrap .list-region {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .mb-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .mb-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 16px;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 4px solid var(--neutral);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .mb-row[data-status="failed"] {
      border-left-color: var(--critical);
    }
    .mb-row[data-status="running"] {
      border-left-color: var(--accent);
    }
    .mb-row[data-status="passed"] {
      border-left-color: var(--good);
    }
    .mb-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mb-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .mb-repo {
      font-weight: 600;
      font-size: 15px;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .mb-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 1px 8px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 999px;
      background: var(--neutral-bg);
      color: var(--ink-2);
      white-space: nowrap;
    }
    /* The latest release is a button that opens its dialog, underlined like
       the repo link beside it, and 44px tall on a phone. A long tag is cut to
       one line; the title has it whole. */
    .mb-release {
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 24px;
      min-width: 0;
      max-width: 100%;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12px;
      font-weight: 600;
      color: var(--ink);
      text-decoration: underline;
    }
    .mb-release-tag {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mb-release .attr-icon {
      flex: none;
    }
    @media (max-width: 760px) {
      .mb-release {
        min-height: 44px;
      }
    }
    /* Open dependency advisories: the word carries the severity, the tint
       echoes it. 44px tall on a phone when it is a link. */
    .mb-advisory {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      box-sizing: border-box;
      padding: 1px 8px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 999px;
      white-space: nowrap;
      background: var(--neutral-bg);
      color: var(--ink-2);
    }
    .mb-advisory[data-tone="critical"],
    .mb-advisory[data-tone="high"] {
      background: var(--critical-bg);
      color: var(--critical);
    }
    .mb-advisory[data-tone="medium"] {
      background: var(--warning-bg);
      color: var(--warning);
    }
    .mb-advisory-cue {
      color: var(--ink-2);
      font-size: 12px;
      padding: 0 4px;
    }
    a.mb-advisory,
    button.mb-advisory {
      text-decoration: underline;
    }
    button.mb-advisory {
      border: 0;
      font-family: inherit;
      cursor: pointer;
    }
    @media (max-width: 760px) {
      a.mb-advisory,
      button.mb-advisory {
        min-height: 44px;
      }
    }
    .mb-stale {
      background: var(--warning-bg);
      color: var(--warning);
    }
    .mb-meta,
    .mb-when,
    .mb-failing,
    .mb-none {
      margin: 0;
      font-size: 12.5px;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .mb-sha,
    .mb-branch {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }
    .mb-failing {
      color: var(--critical);
    }
    .mb-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 36px;
      padding: 0 12px;
      font: inherit;
      font-size: 13px;
      color: var(--ink);
      background: var(--surface-sunken);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      text-decoration: none;
      cursor: pointer;
    }
    .mb-empty {
      padding: 28px 16px;
      text-align: center;
      color: var(--ink-2);
      background: var(--surface);
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius);
    }
    .mb-empty p {
      margin: 0 0 12px;
    }
    /* The CI slot (#1563) sits top right; its look comes from style.css. */
    .mb-row .ci-slot {
      grid-column: 2;
      grid-row: 1;
      align-self: start;
      justify-self: end;
    }
    .mb-row .mb-main {
      grid-column: 1;
      grid-row: 1 / span 2;
    }
    /* The pill is the row's one way to the pipeline, so it is a real control:
       a taller pill with a larger label, 32px on a desktop and 44px on a
       phone, in the same colours as the pull request board's. */
    .mb-row .ci-host {
      display: contents;
    }
    .mb-row .ci-slot {
      width: auto;
      min-width: 120px;
    }
    .mb-row .ci-pill {
      box-sizing: border-box;
      justify-content: center;
      min-height: 32px;
      padding: 6px 14px;
      font-size: 13px;
    }
    .mb-row .ci-pill .check-glyph {
      width: 14px;
      height: 14px;
    }
    /* A pill with counts is a capsule of segments that carry their own
       padding, and its slot grows to it, as on the pull request pages. */
    .mb-row .ci-pill.segmented {
      padding: 0;
      justify-content: flex-start;
    }
    .mb-row .ci-pill.segmented .check-glyph {
      width: 12px;
      height: 12px;
    }
    .mb-row .ci-slot:has(.ci-pill.segmented) {
      width: max-content;
    }
    /* Right edge on the slot's right edge, as tall as the pills beside it, so
       no state moves the row. */
    .mb-nopipe {
      margin-left: auto;
      min-height: 32px;
      align-items: center;
    }
    @media (max-width: 420px) {
      .mb-wrap {
        padding-top: 16px;
      }
      .mb-pill,
      .mb-search,
      .mb-toggle {
        min-height: 44px;
      }
      .mb-bar {
        flex-direction: column;
        align-items: stretch;
      }
      .mb-search {
        flex: none;
      }
      .mb-row {
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 12px;
      }
      .mb-row .mb-main {
        grid-row: 1;
      }
    }
    @media (max-width: 760px) {
      .mb-row .ci-pill {
        min-height: 44px;
      }
    }
  </style>
</svelte:head>

<div class="mb-wrap">
  <div class="mb-header">
    <h1>Main branches</h1>
  </div>

  <!-- Always mounted, so it is empty before it speaks and a screen reader
       announces the change (#1672). -->
  <FirstRefreshStatus {pending} />
  <!-- Always mounted, so it is empty before it speaks and is announced when
       filled. -->
  <p
    class="mb-banner"
    role="status"
    data-testid="rerun-redraw-note"
    hidden={!redrawFailed}
  >
    {redrawFailed ? REDRAW_NOTE : ""}
  </p>
  {#if pending}
    <div class="list-region" aria-busy="true">
      <ListSkeleton />
    </div>
  {:else if loading}
    <p class="mb-loading" role="status">Loading the main branches…</p>
  {:else if failed}
    <div class="mb-note" role="alert">
      <p>Couldn't load the main branches.</p>
      <button type="button" class="mb-toggle" onclick={retry}>Retry</button>
    </div>
  {:else if data}
    {#if startingRows.length > 0}
      <div class="mb-banner" role="status" data-testid="starting-banner">
        <p>
          The app is starting up, so {startingRows.length === 1
            ? "1 repository shows"
            : `${startingRows.length} repositories show`} the status saved by the
          last run until the first refresh answers. Those rows are marked stale.
        </p>
      </div>
    {/if}
    {#if staleRows.length > 0}
      <div class="mb-banner" role="status" data-testid="stale-banner">
        <p>
          {staleRows.length === 1
            ? "1 repository shows"
            : `${staleRows.length} repositories show`} the last known status because
          their forge can't be read right now{staleSince
            ? ` (last read ${formatTime(staleSince)})`
            : ""}. Those rows are marked stale.
        </p>
      </div>
    {/if}

    {#if advisoryState === "none"}
      <div class="mb-banner" role="status" data-testid="advisories-notice">
        <p>
          Advisories can't be read for your GitHub repositories, so none are
          shown.
          {#if advisoryReason}
            {ADVISORY_REASON_TEXT[advisoryReason]}
          {:else}
            Most likely the credential lacks the Dependabot alerts permission
            (read-only), or alerts are switched off on the repo. A rate limit or
            a GitHub error looks the same.
          {/if}
          {#if !advisoryReason || advisoryReasonNeedsGrant(advisoryReason)}
            A permission you just accepted can take up to an hour and a quarter
            to show; saving Settings reads them again at once. <a
              href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/main-branches.md#when-advisories-cant-be-read"
              target="_blank"
              rel="noopener noreferrer"
              >How to grant it<span class="sr-only">
                (opens in a new tab)</span
              ></a
            >.
          {/if}
        </p>
      </div>
    {/if}

    {#if forgejoAdvisoryState === "none"}
      <div
        class="mb-banner"
        role="status"
        data-testid="forgejo-advisories-notice"
      >
        <p>
          Advisories can't be read for your Forgejo repositories, so none are
          shown.
          {#if forgejoAdvisoryReasonText(forgejoAdvisoryReason)}
            {forgejoAdvisoryReasonText(forgejoAdvisoryReason)}
          {:else}
            OSV may be unreachable, or a lock file could not be read, was over 8
            megabytes or lists too many packages.
          {/if}
          <a
            href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/main-branches.md#forgejo-advisories"
            target="_blank"
            rel="noopener noreferrer"
            >How Forgejo advisories are read<span class="sr-only">
              (opens in a new tab)</span
            ></a
          >.
        </p>
      </div>
    {/if}

    {#if branchesAwaitingFlag(firstRefresh.settled, counts.total)}
      <p class="mb-loading" data-testid="branches-awaiting-flag">
        Loading the main branches…
      </p>
    {:else if counts.total === 0}
      <div class="mb-empty" data-testid="no-repos">
        <p>No repositories are tracked yet.</p>
      </div>
    {:else}
      {#if allGreen}
        <div class="mb-note good" data-testid="all-green">
          <p>Every default branch is passing.</p>
        </div>
      {/if}

      <div class="mb-bar">
        <div class="mb-group" role="group" aria-label="Filter by status">
          {#each STATUS_PILLS.filter( (p) => statusOffered.has(p.key) ) as { key, label } (key)}
            <button
              type="button"
              class="mb-pill"
              aria-pressed={filter.status === key}
              onclick={() => setStatus(key)}
              >{label}
              <span class="mb-count">{statusCount(counts, key)}</span></button
            >
          {/each}
        </div>
        <div class="mb-group" role="group" aria-label="Filter by forge">
          <button
            type="button"
            class="mb-pill"
            aria-pressed={filter.forge === "all"}
            onclick={() => setForge("all")}>All forges</button
          >
          {#each (["github", "forgejo"] as const).filter( (f) => forgeOffered.has(f) ) as forge (forge)}
            <button
              type="button"
              class="mb-pill"
              aria-pressed={filter.forge === forge}
              onclick={() => setForge(forge)}
              >{FORGE_LABELS[forge]}
              <span class="mb-count">{perForge[forge]}</span></button
            >
          {/each}
        </div>
        {#if advisoryOffered.size > 1}
          <div class="mb-group" role="group" aria-label="Filter by advisories">
            <button
              type="button"
              class="mb-pill"
              aria-pressed={filter.advisories === "all"}
              onclick={() => setAdvisories("all")}>Any advisories</button
            >
            {#each [["has", "Has advisories"], ["none", "No advisories"]] as const as [key, label] (key)}
              {#if advisoryOffered.has(key)}
                <button
                  type="button"
                  class="mb-pill"
                  aria-pressed={filter.advisories === key}
                  onclick={() => setAdvisories(key)}
                  >{label}
                  <span class="mb-count">{advisoryTally[key]}</span></button
                >
              {/if}
            {/each}
            {#if advisoryTally.unknown > 0}
              <span class="mb-left-out" data-testid="advisory-filter-unknown"
                >{advisoryTally.unknown}
                {advisoryTally.unknown === 1
                  ? "branch with unknown advisories is"
                  : "branches with unknown advisories are"} in neither choice</span
              >
            {/if}
          </div>
        {/if}
        <input
          type="search"
          class="mb-search"
          aria-label="Search repositories, commits, authors and failing jobs"
          placeholder="Search repos, authors, jobs"
          value={filter.query}
          oninput={setQuery}
        />
      </div>

      {#if visible.length === 0}
        <div class="mb-empty" data-testid="no-match">
          <p>Nothing matches these filters.</p>
          {#if isFiltered(filter)}
            <button type="button" class="mb-toggle" onclick={reset}
              >Reset filters</button
            >
          {/if}
        </div>
      {:else}
        <ul class="mb-list" aria-label="Default branches">
          {#each visible as b (rowKey(b))}
            {@const adv = advisoryPill(b.advisories)}
            {@const pill = { status: b.status, counts: b.checks }}
            <li
              class="mb-row"
              data-testid="main-branch-row"
              data-status={pill.status}
            >
              <div class="ci-slot mb-status" data-status={pill.status}>
                {#if CI_SLOT[pill.status]}
                  {@const slot = CI_SLOT[pill.status]!}
                  <!-- The pull request pages' own pill, drawn by the same code
                       (#lib/ci-pill): a native button that opens the pipeline
                       panel, the visible word leading the name (WCAG 2.5.3). -->
                  <span
                    class="ci-host"
                    {@attach (host) => drawPill(host, b, pill, slot)}
                  ></span>
                {:else}
                  <span class="attr-chip mb-nopipe">
                    <svg
                      viewBox="0 0 16 16"
                      class="attr-icon"
                      aria-hidden="true"
                      focusable="false"
                      ><circle
                        cx="8"
                        cy="8"
                        r="6.25"
                        stroke-dasharray="2 2"
                      /></svg
                    >{STATUS_LABEL[pill.status]}
                  </span>
                {/if}
              </div>
              <div class="mb-main">
                <div class="mb-top">
                  <a
                    class="mb-repo"
                    href={b.url}
                    title={b.fullName}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="{b.fullName} (opens in a new tab)"
                    >{b.fullName}</a
                  >
                  <span class="forge-badge {FORGE_CLASSES[b.forge] ?? ''}"
                    ><span class="dot"></span>{FORGE_LABELS[b.forge] ??
                      b.forge}</span
                  >
                  {#if isStale(b)}<span class="mb-chip mb-stale">stale</span
                    >{/if}
                  {#if b.latestRelease && httpHref(b.latestRelease.url)}
                    {@const release = b.latestRelease}
                    <!-- A native button, as the CI pill is: it opens the
                      release dialog, which carries the link to the forge. -->
                    <button
                      type="button"
                      class="mb-release"
                      id={releaseTriggerId(b)}
                      data-testid="main-branch-release"
                      title={release.tag}
                      aria-haspopup="dialog"
                      aria-label="Latest release {release.tag}, open details"
                      onclick={() => openRelease(b)}
                      ><svg
                        viewBox="0 0 16 16"
                        class="attr-icon"
                        aria-hidden="true"
                        focusable="false"
                        ><path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6z" /><circle
                          cx="5.5"
                          cy="5.5"
                          r="1"
                        /></svg
                      ><span class="mb-release-tag">{release.tag}</span></button
                    >
                  {/if}
                  {#if (b.forge === "forgejo" ? forgejoAdvisoryState : advisoryState) === "partial" && advisoryRowUnreadable(b)}
                    <span
                      class="mb-advisory-cue"
                      data-testid="main-branch-advisories-cue"
                      title={advisoryRowHint(b)}
                      ><span aria-hidden="true">&#8211;</span><span
                        class="sr-only">Advisories unknown</span
                      ></span
                    >
                  {/if}
                  {#if adv}
                    <!-- Severity is the word beside the count; the colour
                      only echoes it. -->
                    {#if (adv.href && b.forge === "github") || b.forge === "forgejo"}
                      <!-- A pill opens the list of the row's advisories here;
                        a GitHub dialog links on to GitHub, a Forgejo one to
                        OSV's page for each advisory. -->
                      <button
                        type="button"
                        class="mb-advisory"
                        data-tone={adv.tone}
                        data-testid="main-branch-advisories"
                        title={adv.hint}
                        aria-haspopup="dialog"
                        aria-label="{adv.text} (opens the advisories){adv.hint
                          ? `. ${adv.hint}`
                          : ''}"
                        onclick={(e) =>
                          advisories?.open({
                            forge: b.forge,
                            fullName: b.fullName,
                            branch: b.branch,
                            opener: e.currentTarget,
                          })}>{adv.text}</button
                      >
                    {:else if adv.href}
                      <a
                        class="mb-advisory"
                        data-tone={adv.tone}
                        data-testid="main-branch-advisories"
                        href={adv.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="{adv.text} (opens in a new tab)"
                        >{adv.text}</a
                      >
                    {:else}
                      <span
                        class="mb-advisory"
                        data-tone={adv.tone}
                        title={adv.hint}
                        data-testid="main-branch-advisories">{adv.text}</span
                      >
                    {/if}
                  {/if}
                </div>
                <p class="mb-meta">
                  {#if b.branch}<span class="mb-branch">{b.branch}</span
                    >{" "}{/if}
                  {#if b.commit}<span class="mb-sha">{b.commit.sha}</span
                    >{" "}{commitText(b.commit)}{/if}
                </p>
                {#if b.status === "failed" && b.failingJobs.length > 0}
                  <p class="mb-failing">Failing: {listed(b)}</p>
                {/if}
                {#if b.status === "none"}
                  <p class="mb-none">{noRunText(b)}</p>
                {:else}
                  <p class="mb-when">{whenText(b)}</p>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</div>

<PipelineDialog bind:this={pipeline} />
<AdvisoriesDialog bind:this={advisories} />
<PullRequestDetailsDialog bind:this={releaseDialog} />
