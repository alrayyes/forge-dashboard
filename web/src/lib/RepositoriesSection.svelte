<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { dashboardRead } from "./dashboard-read.svelte.js";
  import FilterGroup from "./FilterGroup.svelte";
  import FilterPill from "./FilterPill.svelte";
  import FirstRefreshStatus from "./FirstRefreshStatus.svelte";
  import ListSkeleton from "./ListSkeleton.svelte";
  import PollingOnlyNotice from "./PollingOnlyNotice.svelte";
  import ReadFailureAlert from "./ReadFailureAlert.svelte";
  import RepoControlIcon from "./RepoControlIcon.svelte";
  import RepoLogo from "./RepoLogo.svelte";
  import RepoToggle from "./RepoToggle.svelte";
  import { failingBadge } from "./failing-repo.js";
  import { firstRefresh } from "./first-refresh.svelte.js";
  import { firstRefreshLoading, readPhase } from "./first-refresh.js";
  import { appConnectionCopy, noReposCopy } from "./forge-copy.js";
  import { dependabotBlockedReason } from "./forge-lock.js";
  import { forgeClassOf, forgeLabelOf } from "./forges.js";
  import { formatTime } from "./time.svelte.js";
  import {
    pollingFilterHolds,
    pollingOnlyCount,
    pollingOnlyReason,
  } from "./polling-only.js";
  import {
    autoUpdateName,
    bulkTargets,
    type BulkControl,
    filterRepos,
    filtersAreClear,
    forgeChoices,
    ignoreName,
    NO_FILTER,
    type RepoSortKey,
    rebaseBotsName,
    sortRepos,
  } from "./repositories.js";

  type Repo = {
    forge: string;
    fullName: string;
    url?: string;
    logoUrl?: string;
    ignored: boolean;
    ignoredPRs: boolean;
    ignoredIssues: boolean;
    autoUpdateBranch: boolean;
    rebaseBots: boolean;
    hasWebhook: boolean;
    canManageWebhooks?: boolean;
    webhookReason?: string;
    webhookReasonDetail?: string;
    webhookNextAttemptAt?: string;
    failingSince?: string;
    failingForGood?: boolean;
  };
  type ForgeHealthEntry = {
    forge: string;
    reachable: boolean;
    dependabotCommandsBlocked?: string;
  };

  // The three scopes POST /api/v1/repos/ignore takes.
  type IgnoreScope = "prs" | "issues" | "both";
  const IGNORE_SCOPE_LABELS: Record<IgnoreScope, string> = {
    prs: "Ignore PRs",
    issues: "Ignore issues",
    both: "Ignore both",
  };
  const IGNORE_SCOPE_DESCRIPTIONS: Record<IgnoreScope, string> = {
    prs: "its pull requests won't show on the dashboard or Insights",
    issues: "its issues won't show on the dashboard or Insights",
    both: "its pull requests and issues won't show on the dashboard or Insights",
  };

  const rowKey = (repo: Pick<Repo, "forge" | "fullName">) =>
    `${repo.forge}:${repo.fullName}`;

  let repos = $state<Repo[]>([]);
  let forges = $state<ForgeHealthEntry[]>([]);
  let loaded = $state(false);
  let originProblem = $state("");
  // Until the first read has an answer worth drawing, the list must not say
  // "Nothing tracked yet" (#3367).
  const awaiting = $derived(
    readPhase(dashboardRead, firstRefresh.done) === "pending",
  );
  const showSkeleton = $derived(awaiting && firstRefreshLoading(firstRefresh));
  const readFailedEmpty = $derived(
    dashboardRead.lastError !== null && repos.length === 0,
  );

  let filter = $state({ ...NO_FILTER });
  let sortKey = $state<RepoSortKey>("fullName");
  let sortDir = $state<"asc" | "desc">("asc");
  let page = $state(1);
  let pageSize = $state(25);
  let sizeChosen = $state(false);

  let statusMessage = $state("");
  let statusKind = $state<"" | "error">("");
  function setStatus(message: string, kind: "" | "error" = "") {
    statusMessage = message;
    statusKind = kind;
  }

  const sortedRepos = $derived(
    sortRepos(filterRepos(repos, filter), sortKey, sortDir),
  );
  const pollingCount = $derived(pollingOnlyCount(repos));
  const ignoredRepos = $derived(repos.filter((r) => r.ignored));
  const offeredForges = $derived(forgeChoices(repos, filter));
  const filtersClear = $derived(filtersAreClear(filter));
  const totalPages = $derived(
    Math.max(1, Math.ceil(sortedRepos.length / pageSize)),
  );
  const clampedPage = $derived(Math.min(page, totalPages));
  const pageItems = $derived(
    sortedRepos.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
  );
  const pageNumbers = $derived(
    Array.from({ length: totalPages }, (_, i) => i + 1),
  );

  let announcement = $state("");
  let prevButton = $state<HTMLButtonElement>();
  let nextButton = $state<HTMLButtonElement>();
  // A disabled button can't hold focus, so a pressed Previous or Next that
  // went inert hands focus to the other one (#3325).
  async function goToPage(n: number) {
    const held = document.activeElement;
    page = n;
    announcement = `Page ${n} of ${totalPages}`;
    await tick();
    if (held === prevButton && prevButton?.disabled)
      nextButton?.focus({ preventScroll: true });
    else if (held === nextButton && nextButton?.disabled)
      prevButton?.focus({ preventScroll: true });
  }

  function changeFilter() {
    page = 1;
    setStatus("");
  }
  // The last polling repo got a hook or was ignored: the notice and its pill
  // are gone, so the filter must not stay on over an empty list (#4786).
  $effect(() => {
    if (
      loaded &&
      !pollingFilterHolds(filter.pollingOnly === true, pollingCount)
    )
      untrack(() => {
        if (filter.pollingOnly) {
          filter.pollingOnly = false;
          changeFilter();
        }
      });
  });
  function togglePolling() {
    filter.pollingOnly = !filter.pollingOnly;
    changeFilter();
  }
  // A link to #repositories lands on the notice's pill, so the one action the
  // notice offers is in view.
  let pollingScrolled = false;
  $effect(() => {
    if (pollingScrolled || !loaded || pollingCount === 0) return;
    if (window.location.hash !== "#repositories") return;
    pollingScrolled = true;
    tick().then(() =>
      document
        .querySelector("#repositories-polling [aria-pressed]")
        ?.scrollIntoView({ block: "center" }),
    );
  });
  function pickForge(forge: string) {
    filter.forge = forge;
    changeFilter();
  }
  // Clearing hides the button, so a keyboard user would lose focus: put it
  // back on the search, the bar's first text control.
  function clearFilters(event: MouseEvent) {
    const byKeyboard = event.detail === 0;
    filter = { ...NO_FILTER };
    sortKey = "fullName";
    sortDir = "asc";
    changeFilter();
    setStatus("Filters cleared.");
    if (byKeyboard) document.getElementById("repositories-search")?.focus();
  }

  const sortChoice = $derived(`${sortKey}:${sortDir}`);
  function chooseSort(value: string) {
    const [key, dir] = value.split(":");
    if (key !== "forge" && key !== "fullName") return;
    sortKey = key;
    sortDir = dir === "desc" ? "desc" : "asc";
    changeFilter();
  }
  function setSort(key: RepoSortKey) {
    if (sortKey === key) sortDir = sortDir === "desc" ? "asc" : "desc";
    else {
      sortKey = key;
      sortDir = "asc";
    }
    changeFilter();
  }
  const ariaSort = (key: RepoSortKey) =>
    sortKey === key
      ? sortDir === "desc"
        ? "descending"
        : "ascending"
      : "none";

  // True while the table is drawn as cards and its header is clipped: the
  // header buttons then leave the tab order.
  let cardLayout = $state(false);
  onMount(() => {
    const query = window.matchMedia("(width <= 760px)");
    const sync = () => (cardLayout = query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  });

  // The layout makes the one /api/v1/dashboard read and owns its 401; follow
  // its answers.
  $effect(() => {
    const { state, data } = dashboardRead;
    if (state === "pending") return;
    untrack(() => {
      repos = (data?.repos as Repo[]) || [];
      forges = (data?.forges as ForgeHealthEntry[]) || [];
      originProblem = data?.webhookOriginProblem ?? "";
      loaded = true;
    });
  });

  // Dependabot ignores a GitHub App, so the switch can't work on a repo whose
  // forge has no personal access token. The server says so per forge.
  function rebaseBotsLock(repo: Repo): string | null {
    return dependabotBlockedReason(forges, repo.forge)
      ? appConnectionCopy(repo.forge).dependabotNeedsToken
      : null;
  }

  // One POST for every write: a pure settings change that never touches the
  // forge, so a status line is enough. Returns the error text, or null.
  async function post(path: string, body: Record<string, unknown>) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return "signed out";
      }
      if (res.status === 204) return null;
      const failure = await res.json().catch(() => ({}));
      return failure?.error || `backend answered ${res.status}`;
    } catch (err) {
      return (err as Error).message;
    }
  }

  let busy = $state<Record<string, boolean>>({});
  const busyKey = (control: string, repo: Repo) => `${control}:${rowKey(repo)}`;

  async function setAutoUpdate(repo: Repo, enabled: boolean): Promise<boolean> {
    const key = busyKey("auto", repo);
    busy[key] = true;
    setStatus(
      `${enabled ? "Enabling" : "Disabling"} auto-update-branch for ${repo.fullName}…`,
    );
    const failed = await post(
      `/api/v1/repos/auto-update-branch/${enabled ? "enable" : "disable"}`,
      { forge: repo.forge, fullName: repo.fullName },
    );
    delete busy[key];
    if (failed) {
      setStatus(
        `Couldn't ${enabled ? "enable" : "disable"} auto-update-branch for ${repo.fullName}: ${failed}`,
        "error",
      );
      return false;
    }
    repo.autoUpdateBranch = enabled;
    setStatus(
      `Auto-update-branch ${enabled ? "enabled" : "disabled"} for ${repo.fullName}.`,
    );
    return true;
  }

  async function setRebaseBots(repo: Repo, enabled: boolean): Promise<boolean> {
    const key = busyKey("rebase", repo);
    busy[key] = true;
    setStatus(
      `${enabled ? "Turning on" : "Turning off"} rebase bots for ${repo.fullName}…`,
    );
    const failed = await post(
      `/api/v1/repos/rebase-bots/${enabled ? "enable" : "disable"}`,
      { forge: repo.forge, fullName: repo.fullName },
    );
    delete busy[key];
    if (failed) {
      setStatus(
        `Couldn't turn ${enabled ? "on" : "off"} rebase bots for ${repo.fullName}: ${failed}`,
        "error",
      );
      return false;
    }
    repo.rebaseBots = enabled;
    setStatus(`Rebase bots ${enabled ? "on" : "off"} for ${repo.fullName}.`);
    return true;
  }

  // Reversible and local, so no confirm step. A repeat call with another scope
  // replaces the saved one.
  async function ignoreRepo(repo: Repo, scope: IgnoreScope) {
    const key = busyKey("ignore", repo);
    busy[key] = true;
    setStatus(`Ignoring ${repo.fullName}…`);
    const failed = await post("/api/v1/repos/ignore", {
      forge: repo.forge,
      fullName: repo.fullName,
      prs: scope === "prs" || scope === "both",
      issues: scope === "issues" || scope === "both",
    });
    delete busy[key];
    if (failed) {
      setStatus(`Couldn't ignore ${repo.fullName}: ${failed}`, "error");
      return;
    }
    repo.ignored = true;
    repo.ignoredPRs = scope === "prs" || scope === "both";
    repo.ignoredIssues = scope === "issues" || scope === "both";
    setStatus(
      `${repo.fullName} is now ignored — ${IGNORE_SCOPE_DESCRIPTIONS[scope]}.`,
    );
  }

  // Un-ignore clears both scopes at once.
  async function unignoreRepo(repo: Repo) {
    const key = busyKey("ignore", repo);
    busy[key] = true;
    setStatus(`Un-ignoring ${repo.fullName}…`);
    const failed = await post("/api/v1/repos/unignore", {
      forge: repo.forge,
      fullName: repo.fullName,
    });
    delete busy[key];
    if (failed) {
      setStatus(`Couldn't un-ignore ${repo.fullName}: ${failed}`, "error");
      return;
    }
    repo.ignored = false;
    repo.ignoredPRs = false;
    repo.ignoredIssues = false;
    setStatus(`${repo.fullName} is no longer ignored.`);
  }

  const bulk = $derived({
    autoUpdateOn: bulkTargets(repos, "autoUpdate", true, rebaseBotsLock),
    autoUpdateOff: bulkTargets(repos, "autoUpdate", false, rebaseBotsLock),
    rebaseBotsOn: bulkTargets(repos, "rebaseBots", true, rebaseBotsLock),
    rebaseBotsOff: bulkTargets(repos, "rebaseBots", false, rebaseBotsLock),
  });
  const plural = (n: number) => `${n} repo${n === 1 ? "" : "s"}`;
  let bulkRunning = $state<string | null>(null);

  async function runBulk(
    control: BulkControl,
    enabled: boolean,
    targets: Repo[],
  ) {
    if (targets.length === 0) return;
    const verb = enabled ? "on" : "off";
    const label = {
      done:
        control === "autoUpdate"
          ? `${enabled ? "Enabled" : "Disabled"} auto-update-branch`
          : `Rebase bots ${verb}`,
    };
    const ok = window.confirm(
      control === "autoUpdate"
        ? `${enabled ? "Enable" : "Disable"} auto-update-branch on ${plural(targets.length)}?`
        : `Turn ${verb} rebase bots for ${plural(targets.length)}?`,
    );
    if (!ok) return;
    bulkRunning = `${control}:${verb}`;
    let succeeded = 0;
    for (const repo of targets) {
      const done =
        control === "autoUpdate"
          ? await setAutoUpdate(repo, enabled)
          : await setRebaseBots(repo, enabled);
      if (done) succeeded++;
    }
    bulkRunning = null;
    const failed = targets.length - succeeded;
    setStatus(
      failed === 0
        ? `${label.done} for all ${succeeded} repos.`
        : `${label.done} for ${succeeded} of ${targets.length} repos — ${failed} failed, see status above.`,
      failed === 0 ? "" : "error",
    );
  }

  const bulkButtons = $derived([
    {
      key: "autoUpdate:on",
      control: "autoUpdate",
      enabled: true,
      targets: bulk.autoUpdateOn,
      text: `Enable auto-update for ${plural(bulk.autoUpdateOn.length)}`,
      busyText: "Enabling auto-update…",
    },
    {
      key: "autoUpdate:off",
      control: "autoUpdate",
      enabled: false,
      targets: bulk.autoUpdateOff,
      text: `Disable auto-update for ${plural(bulk.autoUpdateOff.length)}`,
      busyText: "Disabling auto-update…",
    },
    {
      key: "rebaseBots:on",
      control: "rebaseBots",
      enabled: true,
      targets: bulk.rebaseBotsOn,
      text: `Rebase bots on for ${plural(bulk.rebaseBotsOn.length)}`,
      busyText: "Turning rebase bots on…",
    },
    {
      key: "rebaseBots:off",
      control: "rebaseBots",
      enabled: false,
      targets: bulk.rebaseBotsOff,
      text: `Rebase bots off for ${plural(bulk.rebaseBotsOff.length)}`,
      busyText: "Turning rebase bots off…",
    },
  ] as const);
</script>

<div id="repositories-section" aria-busy={awaiting ? "true" : undefined}>
  <ReadFailureAlert />
  <FirstRefreshStatus pending={showSkeleton} subject="repositories" srOnly />

  <p class="hint">
    Every tracked repo, and what the dashboard does for it. Webhooks are set up
    on their own; a repo without one says why on its row, and the guide covers
    <a
      href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/webhooks.md#polling-only"
      target="_blank"
      rel="noopener noreferrer"
    >
      polling only
    </a>.
  </p>

  {#if awaiting}
    {#if showSkeleton}<ListSkeleton />{/if}
  {:else if readFailedEmpty}
    <!-- The alert above says why; an empty list must not read as a result. -->
  {:else if loaded && repos.length === 0}
    <p class="empty-state" id="repositories-empty">{noReposCopy()}</p>
  {:else if loaded}
    {#each bulkButtons as b (b.key)}
      {#if b.targets.length > 0}
        <button
          type="button"
          class="row-action bulk-button"
          disabled={bulkRunning !== null}
          onclick={() => runBulk(b.control, b.enabled, [...b.targets])}
        >
          {bulkRunning === b.key ? b.busyText : b.text}
        </button>
      {/if}
    {/each}

    <p
      class="status"
      class:error={statusKind === "error"}
      id="repositories-status"
      role="status"
      aria-live="polite"
    >
      {statusMessage}
    </p>

    <PollingOnlyNotice
      id="repositories-polling"
      count={pollingCount}
      pressed={filter.pollingOnly === true}
      onpress={togglePolling}
    />

    <div class="filter-bar" role="search" aria-label="Filter repositories">
      <div class="forge-scroll">
        <FilterGroup label="Forge" id="repositories-forge">
          <FilterPill
            pressed={filter.forge === ""}
            onclick={() => pickForge("")}
          >
            All
          </FilterPill>
          {#each offeredForges as forge (forge)}
            <FilterPill
              pressed={filter.forge === forge}
              data-forge={forge}
              onclick={() => pickForge(forge)}
            >
              {forgeLabelOf(forge)}
            </FilterPill>
          {/each}
        </FilterGroup>
      </div>
      <div class="search-field">
        <input
          class="col-filter"
          type="search"
          id="repositories-search"
          placeholder="Search repos"
          aria-label="Filter by repo name"
          autocomplete="off"
          bind:value={filter.search}
          oninput={changeFilter}
        />
        {#if !filtersClear}
          <button type="button" class="clear-filters" onclick={clearFilters}>
            Clear filters
          </button>
        {/if}
      </div>
      <select
        class="group-select repositories-sort"
        id="repositories-sort-select"
        aria-label="Sort by"
        value={sortChoice}
        onchange={(e) => chooseSort(e.currentTarget.value)}
      >
        <option value="fullName:asc">Sort: Repo, A to Z</option>
        <option value="fullName:desc">Sort: Repo, Z to A</option>
        <option value="forge:asc">Sort: Forge, A to Z</option>
        <option value="forge:desc">Sort: Forge, Z to A</option>
      </select>
    </div>

    {#if sortedRepos.length === 0}
      <p class="empty-state" id="repositories-no-results">
        No repos match these filters.
      </p>
    {:else}
      <!-- The card layout sets display: block on every table element, which drops
           the implicit roles; an explicit role survives. -->
      <!-- svelte-ignore a11y_no_redundant_roles -->
      <table class="repo-table" id="repositories-table" role="table">
        <caption class="sr-only">Every tracked repo's settings</caption>
        <!-- svelte-ignore a11y_no_redundant_roles -->
        <thead role="rowgroup">
          <!-- svelte-ignore a11y_no_redundant_roles -->
          <tr role="row">
            {#each [["forge", "Forge"], ["fullName", "Repo"]] as [key, label] (key)}
              <th
                scope="col"
                role="columnheader"
                aria-sort={ariaSort(key as RepoSortKey)}
              >
                <button
                  type="button"
                  class="sort-button"
                  tabindex={cardLayout ? -1 : undefined}
                  data-sort-key={key}
                  onclick={() => setSort(key as RepoSortKey)}
                >
                  {label}<span class="sort-arrow" aria-hidden="true">
                    {sortKey === key ? (sortDir === "desc" ? "▼" : "▲") : ""}
                  </span>
                </button>
              </th>
            {/each}
            <th scope="col" role="columnheader" class="icon-col">
              Auto-update
            </th>
            <th scope="col" role="columnheader" class="icon-col">
              Rebase bots
              <button
                type="button"
                class="info-button"
                aria-label="About rebase bots"
                aria-describedby="repositories-rebase-info"
              >
                <span aria-hidden="true">ⓘ</span>
              </button>
              <span class="sr-only" id="repositories-rebase-info">
                Rebase bots sends Dependabot and Renovate pull requests their
                own rebase when they fall behind. Human, draft and release pull
                requests are left alone.
              </span>
            </th>
            <th scope="col" role="columnheader" class="icon-col">Ignore</th>
          </tr>
        </thead>
        <!-- svelte-ignore a11y_no_redundant_roles -->
        <tbody id="repositories-rows" role="rowgroup">
          {#each pageItems as repo (rowKey(repo))}
            {@const lock = rebaseBotsLock(repo)}
            {@const lockedOff = lock !== null && !repo.rebaseBots}
            <!-- svelte-ignore a11y_no_redundant_roles -->
            <tr role="row">
              <td role="cell" data-label="Forge">
                <span class={`forge-badge ${forgeClassOf(repo.forge)}`}>
                  <span class="dot"></span>
                  {forgeLabelOf(repo.forge)}
                </span>
              </td>
              <td role="cell" data-label="Repo" class="name-cell">
                <RepoLogo
                  forge={repo.forge}
                  url={repo.logoUrl}
                  name={repo.fullName}
                />{#if repo.url}<a
                    class="repo-link"
                    href={repo.url}
                    title={repo.fullName}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {repo.fullName}
                  </a>{:else}{repo.fullName}{/if}
                {#if repo.failingSince}
                  {@const failing = failingBadge(repo, formatTime)}
                  <span class="failing-live">
                    <span
                      class="failing-badge"
                      class:failing-for-good={failing?.forGood}
                    >
                      {failing?.label}
                    </span>
                    <span class="failing-note">{failing?.note}</span>
                  </span>
                {/if}
                {#if !repo.ignored && !repo.hasWebhook}
                  {@const why = pollingOnlyReason(repo, originProblem)}
                  <span class="polling-reason" data-testid="polling-reason">
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        d="M8 1.75 14.5 13.5h-13z"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M8 6.5v3.25M8 11.5v.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
                    {why.line}
                    <a
                      class="polling-link"
                      href={why.link.href}
                      target={why.link.href.startsWith("http")
                        ? "_blank"
                        : undefined}
                      rel={why.link.href.startsWith("http")
                        ? "noopener noreferrer"
                        : undefined}
                    >
                      {why.link.text}
                    </a>
                  </span>
                {/if}
              </td>
              <td role="cell" class="control-cell" data-label="Auto-update">
                <RepoToggle
                  kind="auto-update"
                  name={autoUpdateName(repo.fullName)}
                  pressed={repo.autoUpdateBranch}
                  busy={busy[busyKey("auto", repo)]}
                  onclick={() => setAutoUpdate(repo, !repo.autoUpdateBranch)}
                />
              </td>
              <td role="cell" class="control-cell" data-label="Rebase bots">
                <RepoToggle
                  kind="rebase-bots"
                  name={rebaseBotsName(repo.fullName)}
                  pressed={repo.rebaseBots}
                  busy={busy[busyKey("rebase", repo)]}
                  disabled={lockedOff}
                  describedby={lockedOff
                    ? `rebase-bots-lock-${rowKey(repo)}`
                    : undefined}
                  onclick={() => setRebaseBots(repo, !repo.rebaseBots)}
                />
                {#if lockedOff}
                  <span
                    class="lock-note"
                    id={`rebase-bots-lock-${rowKey(repo)}`}
                  >
                    {lock}
                  </span>
                {/if}
              </td>
              <td role="cell" class="control-cell" data-label="Ignore">
                <span
                  class="repo-control ignore-control"
                  data-tip={ignoreName(repo.fullName)}
                >
                  <select
                    class="ignore-select"
                    aria-busy={busy[busyKey("ignore", repo)]
                      ? "true"
                      : undefined}
                    aria-label={ignoreName(repo.fullName)}
                    disabled={busy[busyKey("ignore", repo)]}
                    value=""
                    onchange={(e) => {
                      const scope = e.currentTarget.value as IgnoreScope;
                      e.currentTarget.value = "";
                      if (scope) ignoreRepo(repo, scope);
                    }}
                  >
                    <option value="" disabled selected>Ignore…</option>
                    {#each Object.entries(IGNORE_SCOPE_LABELS) as [scope, label] (scope)}
                      <option value={scope}>{label}</option>
                    {/each}
                  </select>
                  <span class="ignore-glyph">
                    <RepoControlIcon kind="ignore" />
                  </span>
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if totalPages > 1 || sizeChosen}
        <div class="pagination" id="repositories-pagination">
          {#if totalPages > 1}
            <div class="pagination-pages">
              <button
                type="button"
                class="pagination-nav"
                disabled={clampedPage <= 1}
                bind:this={prevButton}
                onclick={() => goToPage(clampedPage - 1)}
              >
                Previous
              </button>
              <span class="pagination-status">
                Page {clampedPage} of {totalPages}
              </span>
              {#each pageNumbers as n (n)}
                <button
                  type="button"
                  class="pagination-page"
                  class:active={n === clampedPage}
                  aria-current={n === clampedPage ? "page" : undefined}
                  onclick={() => goToPage(n)}
                >
                  {n}
                </button>
              {/each}
              <button
                type="button"
                class="pagination-nav"
                disabled={clampedPage >= totalPages}
                bind:this={nextButton}
                onclick={() => goToPage(clampedPage + 1)}
              >
                Next
              </button>
            </div>
            <span class="sr-only" role="status" aria-live="polite">
              {announcement}
            </span>
          {/if}
          <label class="pagination-size">
            Per page
            <select
              id="repositories-page-size"
              aria-label="Results per page"
              bind:value={pageSize}
              onchange={() => {
                sizeChosen = true;
                page = 1;
              }}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        </div>
      {/if}
    {/if}

    {#if ignoredRepos.length > 0}
      <details class="ignored-disclosure" id="repositories-ignored">
        <summary>Ignored ({ignoredRepos.length})</summary>
        <ul>
          {#each ignoredRepos as repo (rowKey(repo))}
            <li>
              <span class={`forge-badge ${forgeClassOf(repo.forge)}`}>
                <span class="dot"></span>
                {forgeLabelOf(repo.forge)}
              </span>
              <RepoLogo
                forge={repo.forge}
                url={repo.logoUrl}
                name={repo.fullName}
              />
              {#if repo.url}
                <a
                  class="repo-link"
                  href={repo.url}
                  title={repo.fullName}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {repo.fullName}
                </a>
              {:else}
                {repo.fullName}
              {/if}
              <span class="ignored-scope">
                {repo.ignoredPRs && repo.ignoredIssues
                  ? "(PRs, issues)"
                  : repo.ignoredPRs
                    ? "(PRs)"
                    : "(issues)"}
              </span>
              <button
                type="button"
                disabled={busy[busyKey("ignore", repo)]}
                onclick={() => unignoreRepo(repo)}
              >
                {busy[busyKey("ignore", repo)] ? "Un-ignoring…" : "Un-ignore"}
              </button>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
</div>

<style>
  .hint {
    font-size: 0.78125rem;
    color: var(--ink-2);
    margin: 0 0 14px;
  }
  .empty-state {
    font-size: 0.78125rem;
    color: var(--ink-2);
    margin: 0;
  }
  .status {
    font-size: 0.78125rem;
    min-height: 1.4em;
    margin: 0 0 12px;
  }
  .status.error {
    color: var(--critical);
  }
  .bulk-button {
    margin: 0 8px 10px 0;
    max-width: 100%;
    white-space: normal;
    text-align: start;
  }
  .bulk-button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .polling-reason {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    margin-top: 4px;
    font-size: 0.8125rem;
    color: var(--text);
  }
  .polling-reason svg {
    flex: none;
    color: var(--warning);
  }
  .failing-live {
    display: block;
    margin-top: 4px;
  }
  .failing-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 0.75rem;
    color: var(--warning);
    background: var(--warning-bg);
  }
  .failing-badge.failing-for-good {
    font-weight: 600;
    color: var(--critical);
    background: var(--critical-bg);
  }
  .failing-note {
    display: block;
    margin-top: 2px;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .polling-link {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    color: var(--accent);
  }
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .search-field {
    position: relative;
    flex: 1 1 180px;
    min-width: 140px;
    display: flex;
    align-items: center;
  }
  .search-field .col-filter {
    width: 100%;
    padding-right: 6.5rem;
  }
  /* A quiet text button inside the field: shown only while a filter is set. */
  .search-field .clear-filters {
    position: absolute;
    right: 4px;
    min-height: 28px;
    padding: 0 8px;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.78125rem;
    text-decoration: underline;
    cursor: pointer;
  }
  .repositories-sort {
    display: none;
    width: auto;
    flex: 1 1 130px;
    min-width: 120px;
  }
  .repo-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  .repo-table th,
  .repo-table td {
    text-align: left;
    padding: 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .repo-table th {
    color: var(--ink-2);
    font-weight: 500;
  }
  .repo-table .icon-col,
  .repo-table .control-cell {
    text-align: center;
  }
  .repo-table .control-cell > :global(.repo-control) {
    vertical-align: middle;
  }
  .repo-link {
    color: inherit;
  }
  .sort-button {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-weight: 500;
    color: var(--ink-2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
  }
  .sort-button:hover,
  .sort-button:focus-visible {
    color: var(--ink);
  }
  .sort-arrow {
    font-size: 0.5625rem;
    min-width: 0.6em;
  }
  .info-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink-2);
    font: inherit;
    cursor: help;
  }
  .lock-note {
    display: block;
    max-width: 200px;
    margin: 4px auto 0;
    font-size: 0.75rem;
    color: var(--ink-2);
    text-align: left;
  }
  /* Ignore is the native select, drawn as the eye-slash button. */
  .ignore-control {
    position: relative;
    display: inline-flex;
  }
  .ignore-select {
    box-sizing: border-box;
    width: 32px;
    height: 32px;
    margin: 0;
    padding: 0;
    appearance: none;
    border: 2px solid var(--control-border);
    border-radius: 6px;
    background: var(--surface);
    color: transparent;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .ignore-select option {
    color: var(--ink);
  }
  .ignore-select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ignore-select:disabled {
    cursor: progress;
    opacity: 0.55;
  }
  .ignore-glyph {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink);
    pointer-events: none;
  }
  .ignored-disclosure {
    margin-top: 18px;
    font-size: 0.78125rem;
    color: var(--ink-2);
  }
  .ignored-disclosure summary {
    cursor: pointer;
    font-weight: 500;
    min-height: 28px;
  }
  .ignored-disclosure ul {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ignored-disclosure li {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .ignored-scope {
    font-size: 0.6875rem;
    color: var(--ink-2);
  }
  .ignored-disclosure button {
    min-height: 28px;
    font-size: 0.78125rem;
    color: var(--accent);
    background: none;
    border: none;
    padding: 0 4px;
    cursor: pointer;
    text-decoration: underline;
    margin-left: auto;
  }
  .ignored-disclosure button:disabled {
    color: var(--ink-3);
    cursor: default;
    text-decoration: none;
  }

  /* Cards up to 760px, the width the app's 44px phone rule also stops at. The
     explicit table roles on the markup keep the table semantics once display
     moves off table cells. */
  @media (width <= 760px) {
    /* Each control takes the bar's full width, so the Forge row, the search
       field and the Sort select share both edges. The pills wrap, never
       scroll or clip (#4855). The tab bar's clearance comes from the body
       padding in the stylesheet. */
    .forge-scroll,
    .search-field,
    .repositories-sort {
      flex: 0 0 auto;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }
    .repositories-sort {
      display: block;
      width: 100%;
    }
    .repo-table,
    .repo-table thead,
    .repo-table tbody,
    .repo-table tr,
    .repo-table th,
    .repo-table td {
      display: block;
    }
    .repo-table thead tr {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .repo-table tbody tr {
      border-bottom: 1px solid var(--border);
      padding: 10px 0;
    }
    .repo-table td {
      border-bottom: none;
      padding: 4px 0;
      overflow-wrap: anywhere;
      text-align: left;
    }
    /* Left text label, right icon control, centred on the row. */
    .repo-table td.control-cell {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 12px;
      min-height: 44px;
    }
    .repo-table td.control-cell::before {
      content: attr(data-label);
      font-size: 0.8125rem;
      color: var(--ink-2);
    }
    .repo-table td.control-cell .lock-note {
      flex-basis: 100%;
      max-width: none;
      margin: 0;
    }
    .ignore-select {
      width: 40px;
      height: 40px;
    }
    .repo-table td[data-label="Forge"]::before,
    .repo-table td[data-label="Repo"]::before {
      content: attr(data-label);
      display: block;
      font-size: 0.6875rem;
      color: var(--ink-2);
    }
  }
</style>
