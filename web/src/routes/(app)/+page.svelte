<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { FORGE_CLASSES, FORGE_LABELS } from "#lib/forges.js";
  import { CHECK_GLYPHS } from "#lib/check-glyphs.js";
  import { formatTime } from "#lib/time.svelte.js";
  import {
    branchesAwaitingFlag,
    firstRefreshJustFinished,
    firstRefreshLoading,
  } from "#lib/first-refresh.js";
  import { firstRefresh } from "#lib/first-refresh.svelte.js";
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
    DEFAULT_FILTER,
    duration,
    forgeCounts,
    offeredForges,
    offeredStatuses,
    isFiltered,
    filterFromState,
    filterToState,
    type MainBranch,
    type MainBranches,
    type MainBranchFilter,
    CI_SLOT,
    STATUS_LABEL,
    type StatusPill,
    type ForgeFilter,
  } from "#lib/main-branches.js";

  const REFRESH_MS = 60_000;

  let data = $state<MainBranches | null>(null);
  let failed = $state(false);
  let loading = $state(true);
  let filter = $state<MainBranchFilter>({ ...DEFAULT_FILTER });
  let expanded = $state<Record<string, boolean>>({});

  // The server's first refresh after a restart has not finished (#1672): the
  // list is empty because nothing is read yet, not because nothing is tracked.
  const pending = $derived(firstRefreshLoading(firstRefresh));
  const branches = $derived(data?.branches ?? []);
  const visible = $derived(applyFilter(branches, filter));
  const perForge = $derived(forgeCounts(branches));
  // A status or forge pill is offered only when clicking it would show
  // something, and the active one stays (#1427).
  const statusOffered = $derived(offeredStatuses(branches, filter));
  const forgeOffered = $derived(offeredForges(branches, filter));
  const staleRows = $derived(branches.filter((b) => b.stale));
  const staleSince = $derived(
    staleRows
      .map((b) => b.staleSince)
      .filter((s): s is string => !!s)
      .sort()[0] ?? null,
  );
  const allGreen = $derived(
    !!data && data.counts.total > 0 && data.counts.passed === data.counts.total,
  );

  const STATUS_PILLS: { key: StatusPill; label: string }[] = [
    { key: "all", label: "All" },
    { key: "failed", label: "Failing" },
    { key: "passed", label: "Passing" },
    { key: "running", label: "Running" },
    { key: "none", label: "No pipeline" },
  ];

  const rowKey = (b: MainBranch) => `${b.forge}:${b.fullName}`;

  async function load(initial = false) {
    try {
      const res = await fetch("/api/main-branches", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      data = (await res.json()) as MainBranches;
      failed = false;
    } catch {
      // A refresh that fails keeps the rows already on screen.
      if (initial || !data) failed = true;
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
  onDestroy(() => leavePage(page));
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
  function setQuery(event: Event) {
    filter.query = (event.currentTarget as HTMLInputElement).value;
    save(["query"], true);
  }
  function reset() {
    filter = { ...DEFAULT_FILTER };
    save(["status", "forge", "query"]);
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
    const timer = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(timer);
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
    .mb-action:focus-visible,
    .mb-toggle:focus-visible,
    .mb-search:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
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
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 12px;
    }
    .mb-failing {
      color: var(--critical);
    }
    .mb-side {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }
    .mb-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .mb-action,
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
    .mb-action {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
      font-weight: 600;
    }
    .mb-jobs {
      grid-column: 1 / -1;
      margin: 0;
      padding: 8px 12px 8px 28px;
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 12.5px;
      background: var(--surface-sunken);
      border-radius: 6px;
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
    .mb-row .mb-side {
      grid-column: 2;
      grid-row: 2;
    }
    .mb-row .ci-pill {
      cursor: default;
    }
    /* Right edge on the slot's right edge, as tall as the pills beside it, so
       no state moves the row. */
    .mb-nopipe {
      margin-left: auto;
      min-height: 24px;
      align-items: center;
    }
    @media (max-width: 420px) {
      .mb-wrap {
        padding-top: 16px;
      }
      .mb-pill,
      .mb-search,
      .mb-action,
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
      .mb-row .mb-side {
        grid-column: 1 / -1;
      }
      .mb-side {
        align-items: stretch;
      }
      .mb-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .mb-actions > :only-child {
        grid-column: 1 / -1;
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

    {#if branchesAwaitingFlag(firstRefresh.settled, data.counts.total)}
      <p class="mb-loading" data-testid="branches-awaiting-flag">
        Loading the main branches…
      </p>
    {:else if data.counts.total === 0}
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
              <span class="mb-count"
                >{key === "all" ? data.counts.total : data.counts[key]}</span
              ></button
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
            {@const key = rowKey(b)}
            <li
              class="mb-row"
              data-testid="main-branch-row"
              data-status={b.status}
            >
              <div class="ci-slot mb-status" data-status={b.status}>
                {#if CI_SLOT[b.status]}
                  {@const slot = CI_SLOT[b.status]!}
                  <span class="ci-pill {slot.cls}">
                    {#each CHECK_GLYPHS[slot.glyphs] as g (g.name)}
                      <svg
                        viewBox="0 0 16 16"
                        class="check-glyph check-glyph-{g.name}"
                        data-glyph={g.name}
                        aria-hidden="true"
                        focusable="false"
                      >
                        <!-- nosemgrep: svelte-at-html -- g.body comes only from the static CHECK_GLYPHS constant in #lib/check-glyphs, never from forge data -->
                        {@html g.body}
                      </svg>
                    {/each}
                    {STATUS_LABEL[b.status]}
                  </span>
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
                    >{STATUS_LABEL[b.status]}
                  </span>
                {/if}
              </div>
              <div class="mb-main">
                <div class="mb-top">
                  <a
                    class="mb-repo"
                    href={b.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="{b.fullName} (opens in a new tab)"
                    >{b.fullName}</a
                  >
                  <span class="forge-badge {FORGE_CLASSES[b.forge] ?? ''}"
                    ><span class="dot"></span>{FORGE_LABELS[b.forge] ??
                      b.forge}</span
                  >
                  {#if b.stale}<span class="mb-chip mb-stale">stale</span>{/if}
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
              <div class="mb-side">
                <div class="mb-actions">
                  <a
                    class="mb-action"
                    href={b.runUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="View run for {b.fullName} (opens in a new tab)"
                    >View run</a
                  >
                  {#if b.status === "failed" && b.failingJobs.length > 0}
                    <button
                      type="button"
                      class="mb-toggle"
                      aria-expanded={!!expanded[key]}
                      aria-controls="jobs-{b.forge}-{b.fullName}"
                      onclick={() => (expanded[key] = !expanded[key])}
                      >Failing jobs ({b.failingJobs.length})</button
                    >
                  {/if}
                </div>
              </div>
              {#if expanded[key]}
                <ul
                  class="mb-jobs"
                  id="jobs-{b.forge}-{b.fullName}"
                  aria-label="Failing jobs for {b.fullName}"
                >
                  {#each b.failingJobs as job}<li>{job}</li>{/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</div>
