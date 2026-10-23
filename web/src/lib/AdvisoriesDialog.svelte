<script module lang="ts">
  // What the Branches page hands the dialog to open it.
  export type AdvisoriesTarget = {
    forge: string;
    fullName: string;
    // The default branch, shown under the title.
    branch?: string;
    // The control to give focus back to when the dialog closes.
    opener?: HTMLElement | null;
  };
</script>

<script lang="ts">
  // The open dependency advisories of one repository: a list sorted by severity
  // and a detail view for the row picked, both drawn from the one read made when
  // the dialog opens. Like the pipeline dialog it is a native modal: Escape, the
  // close button and a click on the backdrop close it, and focus goes back to
  // the control that opened it.
  import { tick } from "svelte";
  import { FORGE_LABELS } from "#lib/forges.js";
  import { renderMarkdown } from "#lib/markdown.js";
  import { ago, httpHref } from "#lib/main-branches.js";
  import { formatDateTime } from "#lib/time.svelte.js";
  import {
    type AdvisoryItem,
    type AdvisoryList,
    type SeverityFilter,
    chipsOf,
    cvssBand,
    epssText,
    filterBySeverity,
    forgeWords,
    unreadableText,
    readAdvisoryList,
    referenceLinks,
    severityCounts,
  } from "#lib/advisories-dialog.js";

  let dialog: HTMLDialogElement;
  let body: HTMLDivElement | undefined = $state();
  let target = $state<AdvisoriesTarget | null>(null);
  let phase = $state<"loading" | "error" | "ready">("loading");
  let message = $state("");
  let list = $state<AdvisoryList | null>(null);
  let filter = $state<SeverityFilter>("all");
  let selected = $state<number | null>(null);
  let html = $state<Record<number, string>>({});
  // The list's scroll position, put back when the way back from a detail lands.
  let scrolled = 0;
  // Only the newest request may draw.
  let request = 0;

  const items = $derived(list?.advisories ?? []);
  const counts = $derived(severityCounts(items));
  const shown = $derived(filterBySeverity(items, filter));
  const current = $derived(
    selected === null
      ? null
      : (items.find((i) => i.number === selected) ?? null),
  );
  const forgeName = $derived(
    target ? (FORGE_LABELS[target.forge] ?? target.forge) : "",
  );
  const words = $derived(forgeWords(target?.forge ?? ""));
  const FILTERS: { key: SeverityFilter; label: string }[] = [
    { key: "all", label: "All open" },
    { key: "critical", label: "Critical" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "low", label: "Low" },
  ];
  const partialNote =
    "Some packages were left out because they may be private, so this list covers only the rest.";
  const countOf = (key: SeverityFilter) =>
    key === "all" ? items.length : counts[key];

  export function open(next: AdvisoriesTarget) {
    if (dialog.open) return;
    target = next;
    filter = "all";
    selected = null;
    html = {};
    list = null;
    void load(next);
    dialog.showModal();
  }

  async function load(row: AdvisoriesTarget) {
    const mine = ++request;
    phase = "loading";
    const result = await readAdvisoryList(row.forge, row.fullName);
    if (mine !== request) return;
    if (result.kind === "signed-out") {
      window.location.href = "/login.html";
      return;
    }
    if (result.kind === "error") {
      message = `Couldn't load the advisories for ${row.fullName}: ${result.message}`;
      phase = "error";
      return;
    }
    list = result.list;
    phase = "ready";
  }

  function closed() {
    request++;
    const done = target;
    target = null;
    selected = null;
    done?.opener?.focus();
  }

  function outside(event: MouseEvent) {
    if (event.target === dialog) dialog.close();
  }

  async function show(item: AdvisoryItem) {
    scrolled = body?.scrollTop ?? 0;
    selected = item.number;
    await tick();
    if (body) body.scrollTop = 0;
    // The Back button is first in the tab order; the keyboard starts there.
    dialog.querySelector<HTMLElement>(".adv-back")?.focus();
    if (item.description && html[item.number] === undefined) {
      const number = item.number;
      const mine = request;
      const text = await renderMarkdown(item.description).catch(() => "");
      // The dialog may have closed, or opened on another repo, meanwhile.
      if (mine !== request) return;
      html[number] = text;
    }
  }

  async function back() {
    const number = selected;
    selected = null;
    await tick();
    if (body) body.scrollTop = scrolled;
    dialog
      .querySelector<HTMLElement>(`[data-number="${number}"]`)
      ?.focus({ preventScroll: true });
  }

  function pick(key: SeverityFilter) {
    filter = key;
  }

  const sevLabel = (s: string | undefined) =>
    s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unrated";
</script>

<dialog
  bind:this={dialog}
  id="advisories-dialog"
  class="adv-dialog"
  aria-labelledby="adv-title"
  onclose={closed}
  onclick={outside}
  data-testid="advisories-dialog"
>
  <div class="adv-header">
    <div class="adv-heading">
      {#if current}
        <button
          type="button"
          class="adv-back"
          data-testid="advisory-back"
          aria-label="Back to advisories"
          onclick={back}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"><path d="M15 18l-6-6 6-6" /></svg
          >Back to advisories
        </button>
      {/if}
      <h2 class="adv-title" id="adv-title">
        {current ? current.summary : "Dependency advisories"}
      </h2>
      <p class="adv-subtitle">
        {target?.fullName ?? ""}{target?.branch ? ` · ${target.branch}` : ""}
        {#if !current}<span class="adv-source">{forgeName}</span>{/if}
      </p>
    </div>
    <div class="adv-header-actions">
      {#if (current?.url ?? list?.url) && httpHref(current?.url ?? list?.url ?? "")}
        <a
          class="adv-ghost"
          data-testid="advisory-open-on-forge"
          href={current?.url ?? list?.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open on {words.linkName} (opens in a new tab)"
          >Open on {words.linkName}</a
        >
      {/if}
      <button
        type="button"
        class="adv-close"
        aria-label="Close"
        onclick={() => dialog.close()}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
        >
      </button>
    </div>
  </div>

  <div class="adv-body" bind:this={body}>
    {#if phase === "loading"}
      <p class="adv-status" role="status">Loading advisories&hellip;</p>
    {:else if phase === "error"}
      <p class="adv-status adv-error" role="alert">{message}</p>
      <button
        type="button"
        class="adv-ghost"
        data-testid="advisories-retry"
        onclick={() => target && load(target)}>Try again</button
      >
    {:else if list?.state === "unknown"}
      <p class="adv-status" data-testid="advisories-unknown" role="status">
        The advisories could not be read. {unreadableText(
          target?.forge ?? "",
          list.reason,
        )}
      </p>
    {:else if current}
      {@render detail(current)}
    {:else if items.length === 0}
      <p class="adv-status" data-testid="advisories-empty" role="status">
        {words.empty}
      </p>
      {#if list?.partial}
        <p class="adv-status" data-testid="advisories-partial" role="status">
          {partialNote}
        </p>
      {/if}
    {:else}
      <div class="adv-filters" role="group" aria-label="Filter by severity">
        {#each FILTERS as f (f.key)}
          {#if f.key === "all" || counts[f.key] > 0}
            <button
              type="button"
              class="adv-filter"
              data-testid="advisory-filter-{f.key}"
              aria-pressed={filter === f.key}
              onclick={() => pick(f.key)}
              >{f.label} <span class="adv-count">{countOf(f.key)}</span></button
            >
          {/if}
        {/each}
        <span class="adv-sorted">Sorted by severity, then age</span>
      </div>
      {#if list?.partial}
        <p class="adv-status" data-testid="advisories-partial" role="status">
          {partialNote}
        </p>
      {/if}
      <ul class="adv-list">
        {#each shown as item (item.number)}
          <li>
            <button
              type="button"
              class="adv-row"
              data-testid="advisory-row"
              data-number={item.number}
              onclick={() => show(item)}
            >
              {@render sev(item.severity)}
              <span class="adv-row-main">
                <span class="adv-row-title">{item.summary}</span>
                <span class="adv-chips">
                  {#each chipsOf(item) as chip (chip.kind)}
                    <span class="adv-chip adv-chip-{chip.kind}"
                      >{chip.text}{chip.detail ? ` · ${chip.detail}` : ""}</span
                    >
                    {" "}
                  {/each}
                </span>
                <span class="adv-row-meta">
                  {#if item.manifestPath}{words.foundIn}
                    <code>{item.manifestPath}</code>{/if}
                  {#if item.openedAt}{item.manifestPath
                      ? " · "
                      : ""}{`${words.dateWord} ${ago(item.openedAt)}`}{/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="adv-footer">
    {#if current}
      <button type="button" class="adv-ghost" onclick={back}
        >Back to advisories</button
      >
    {/if}
    <button type="button" class="adv-ghost" onclick={() => dialog.close()}
      >Close</button
    >
  </div>
</dialog>

{#snippet sev(severity: string | undefined)}
  <span class="adv-sev" data-severity={severity ?? "none"}
    ><svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      >{#if severity === "critical" || severity === "high"}<path
          d="M8 1.5 15 14H1z"
        />{:else if severity === "medium"}<path
          d="M8 1.5 14.5 8 8 14.5 1.5 8z"
        />{:else}<circle cx="8" cy="8" r="5.5" />{/if}</svg
    >{sevLabel(severity)}</span
  >
{/snippet}

{#snippet detail(item: AdvisoryItem)}
  <div class="adv-badges">
    <span class="adv-chip">{item.state === "open" ? "Open" : item.state}</span>
    {@render sev(item.severity)}
    {#if item.id && item.id !== item.ghsaId && item.id !== item.cveId}<span
        class="adv-chip adv-id">{item.id}</span
      >{/if}
    {#if item.ghsaId}<span class="adv-chip adv-id">{item.ghsaId}</span>{/if}
    {#if item.cveId}<span class="adv-chip adv-id">{item.cveId}</span>{/if}
  </div>
  <dl class="adv-fields" data-testid="advisory-detail">
    {#if item.package}
      <div>
        <dt>Package</dt>
        <dd>
          {item.package}{item.ecosystem
            ? ` (${item.ecosystem})`
            : ""}{item.relationship ? `, ${item.relationship}` : ""}{item.scope
            ? `, ${item.scope}`
            : ""}
        </dd>
      </div>
    {/if}
    {#if item.manifestPath}
      <div>
        <dt>{words.fileLabel}</dt>
        <dd><code>{item.manifestPath}</code></dd>
      </div>
    {/if}
    {#if item.openedAt}
      <div>
        <dt>{words.dateWord}</dt>
        <dd>{formatDateTime(item.openedAt)} ({ago(item.openedAt)})</dd>
      </div>
    {/if}
    {#if item.vulnerableVersions}
      <div>
        <dt>Vulnerable versions</dt>
        <dd><code>{item.vulnerableVersions}</code></dd>
      </div>
    {/if}
    <div>
      <dt>{words.patchedLabel}</dt>
      <dd>
        {#if item.patchedVersion}<code>{item.patchedVersion}</code>{:else}No
          patched version yet{/if}
      </dd>
    </div>
    {#if item.cvss && item.cvss.score !== undefined}
      <div>
        <dt>Severity score</dt>
        <dd>
          {item.cvss.score.toFixed(1)} ({cvssBand(
            item.cvss.score,
          )}){#if item.cvss.vector}
            <code class="adv-vector">{item.cvss.vector}</code>{/if}
        </dd>
      </div>
    {/if}
    {#if item.weaknesses?.length}
      <div>
        <dt>Weaknesses</dt>
        <dd>
          {item.weaknesses
            .map((w) => (w.name ? `${w.id} ${w.name}` : w.id))
            .join(", ")}
        </dd>
      </div>
    {/if}
    {#if item.epss}
      <div>
        <dt>EPSS</dt>
        <dd>{epssText(item.epss)}</dd>
      </div>
    {/if}
  </dl>
  {#if item.description}
    <h3 class="adv-h3">Description</h3>
    {#if html[item.number]}
      <!-- nosemgrep: svelte-at-html -- html holds only renderMarkdown() output: markdown-it with html:false, the image rule off and non-http(s)/mailto links turned to text, never raw forge text -->
      <div class="markdown adv-description">{@html html[item.number]}</div>
    {:else}
      <p class="adv-status">Loading the description&hellip;</p>
    {/if}
  {/if}
  {#if referenceLinks(item.references).length}
    <h3 class="adv-h3">References</h3>
    <ul class="adv-refs">
      {#each referenceLinks(item.references) as ref (ref.url)}
        <li>
          <a href={ref.url} target="_blank" rel="noopener noreferrer"
            >{ref.url}<span class="sr-only"> (opens in a new tab)</span></a
          >
          <span class="adv-host">{ref.host}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<style>
  .adv-dialog {
    position: fixed;
    inset: 0;
    margin: auto;
    width: min(760px, 100vw);
    max-width: 100vw;
    height: min(86vh, 900px);
    max-height: 100%;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 0;
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  .adv-dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .adv-dialog::backdrop {
    background: var(--backdrop);
  }
  .adv-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .adv-heading {
    min-width: 0;
  }
  .adv-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .adv-subtitle {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--ink-2);
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    overflow-wrap: anywhere;
  }
  .adv-source {
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 8px;
    margin-left: 6px;
  }
  .adv-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .adv-back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    margin: 0 0 8px;
    padding: 0 10px 0 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-sunken);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .adv-close,
  .adv-ghost,
  .adv-back,
  .adv-row,
  .adv-filter {
    cursor: pointer;
  }
  .adv-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--ink-2);
  }
  .adv-ghost {
    display: inline-flex;
    align-items: center;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-decoration: none;
  }
  .adv-close:focus-visible,
  .adv-ghost:focus-visible,
  .adv-back:focus-visible,
  .adv-row:focus-visible,
  .adv-filter:focus-visible,
  .adv-refs a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .adv-body {
    padding: 14px 18px 18px;
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .adv-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 18px;
    border-top: 1px solid var(--border);
    flex: none;
  }
  .adv-status {
    margin: 0 0 12px;
    color: var(--ink-2);
    font-size: 13.5px;
  }
  .adv-error {
    color: var(--critical);
  }
  .adv-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .adv-filter {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .adv-filter[aria-pressed="true"] {
    background: var(--ink);
    color: var(--surface);
    border-color: var(--ink);
  }
  .adv-count {
    font-weight: 600;
  }
  .adv-sorted {
    margin-left: auto;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .adv-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .adv-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    text-align: left;
  }
  .adv-row:hover {
    background: var(--surface-sunken);
  }
  .adv-row-main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .adv-row-title {
    font-weight: 600;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .adv-row-meta {
    font-size: 12.5px;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .adv-chips,
  .adv-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .adv-badges {
    margin-bottom: 12px;
  }
  .adv-chip,
  .adv-sev {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    background: var(--neutral-bg);
    color: var(--ink-2);
    white-space: nowrap;
  }
  .adv-sev {
    gap: 4px;
  }
  .adv-sev[data-severity="critical"],
  .adv-sev[data-severity="high"] {
    background: var(--critical-bg);
    color: var(--critical);
  }
  .adv-sev[data-severity="medium"] {
    background: var(--warning-bg);
    color: var(--warning);
  }
  .adv-fields {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 20px;
  }
  .adv-fields dt {
    font-size: 12px;
    color: var(--ink-2);
  }
  .adv-fields dd {
    margin: 2px 0 0;
    font-size: 13.5px;
    overflow-wrap: anywhere;
  }
  .adv-vector {
    display: block;
    font-size: 12px;
    color: var(--ink-2);
  }
  .adv-h3 {
    margin: 18px 0 8px;
    font-size: 14px;
  }
  .adv-description {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    background: var(--surface-sunken);
    overflow-wrap: anywhere;
  }
  .adv-refs {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .adv-refs a {
    overflow-wrap: anywhere;
  }
  .adv-host {
    color: var(--ink-2);
    margin-left: 6px;
  }
  @media (max-width: 760px) {
    .adv-dialog {
      inset: auto 0 0 0;
      margin: 0;
      width: 100vw;
      height: 92vh;
      border-radius: 14px 14px 0 0;
    }
    .adv-fields {
      grid-template-columns: minmax(0, 1fr);
    }
    .adv-sorted {
      margin-left: 0;
      flex-basis: 100%;
    }
    .adv-row,
    .adv-filter,
    .adv-ghost,
    .adv-back,
    .adv-close {
      min-height: 44px;
    }
    .adv-close {
      width: 44px;
    }
    .adv-header {
      flex-wrap: wrap;
    }
  }
</style>
