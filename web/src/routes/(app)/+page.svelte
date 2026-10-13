<script lang="ts">
  import { onMount } from "svelte";
  import { FORGE_CLASSES, FORGE_LABELS } from "#lib/forges.js";
  import { formatTime } from "#lib/time.svelte.js";
  import {
    ago,
    applyFilter,
    DEFAULT_FILTER,
    duration,
    forgeCounts,
    isFiltered,
    loadFilter,
    type MainBranch,
    type MainBranches,
    type MainBranchFilter,
    saveFilter,
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

  const branches = $derived(data?.branches ?? []);
  const visible = $derived(applyFilter(branches, filter));
  const perForge = $derived(forgeCounts(branches));
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

  function setStatus(status: StatusPill) {
    filter.status = status;
    saveFilter(filter);
  }
  function setForge(forge: ForgeFilter) {
    filter.forge = forge;
    saveFilter(filter);
  }
  function setQuery(event: Event) {
    filter.query = (event.currentTarget as HTMLInputElement).value;
    saveFilter(filter);
  }
  function reset() {
    filter = { ...DEFAULT_FILTER };
    saveFilter(filter);
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

  onMount(() => {
    filter = loadFilter();
    load(true);
    const timer = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(timer);
  });
</script>

<svelte:head>
  <title>Main branches — Forge Board</title>
  <meta
    name="description"
    content="The CI status of every tracked repository's default branch, failing first."
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
    .mb-status[data-status="failed"] {
      background: var(--critical-bg);
      color: var(--critical);
    }
    .mb-status[data-status="passed"] {
      background: var(--good-bg);
      color: var(--good);
    }
    .mb-status[data-status="running"] {
      background: var(--surface-sunken);
      color: var(--ink);
      border: 1px solid var(--accent);
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
    .mb-spin {
      animation: mb-spin 1.2s linear infinite;
    }
    @keyframes mb-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .mb-spin {
        animation: none;
      }
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
        grid-template-columns: minmax(0, 1fr);
        padding: 12px;
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

  {#if loading}
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

    {#if data.counts.total === 0}
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
          {#each STATUS_PILLS as { key, label } (key)}
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
          {#each ["github", "forgejo"] as const as forge (forge)}
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
              <div class="mb-main">
                <div class="mb-top">
                  <span class="mb-chip mb-status" data-status={b.status}>
                    <svg
                      class:mb-spin={b.status === "running"}
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      {#if b.status === "failed"}
                        <circle cx="12" cy="12" r="10" /><path
                          d="m15 9-6 6"
                        /><path d="m9 9 6 6" />
                      {:else if b.status === "passed"}
                        <circle cx="12" cy="12" r="10" /><path
                          d="m9 12 2 2 4-4"
                        />
                      {:else if b.status === "running"}
                        <path d="M21 12a9 9 0 1 1-6.2-8.55" /><path
                          d="M21 3v6h-6"
                        />
                      {:else}
                        <circle cx="12" cy="12" r="10" stroke-dasharray="3 4" />
                      {/if}
                    </svg>
                    {STATUS_LABEL[b.status]}
                  </span>
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
