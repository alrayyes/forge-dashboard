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
  import { tipDismiss } from "./tip-dismiss";
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
    lockedTip,
    toggleTip,
    bulkTargets,
    type BulkControl,
    filterRepos,
    filtersAreClear,
    forgeChoices,
    ignoreName,
    ignoreScopeOf,
    ignoreScopeWords,
    ignoreTip,
    type IgnoredView,
    repoKey,
    NO_FILTER,
    type RepoSortKey,
    repoCountText,
    repoScope,
    type ToggleView,
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
  // Repos toggled since the page opened or the filter last changed: they stay
  // in the list even when the Ignored filter would hide them, so a tap can be
  // undone and the row never jumps under the finger (#4854).
  let kept = $state<Set<string>>(new Set());
  function keep(repo: Repo) {
    kept = new Set(kept).add(repoKey(repo));
  }
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
    sortRepos(filterRepos(repos, filter, kept), sortKey, sortDir),
  );
  const pollingCount = $derived(pollingOnlyCount(repos));
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

  // A person's filter change lets go of the rows kept after a toggle; the
  // automatic reset below keeps them.
  function changeFilter(releaseKept = true) {
    if (releaseKept) kept = new Set();
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
          changeFilter(false);
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
  const IGNORED_VIEWS: { view: IgnoredView; label: string }[] = [
    { view: "active", label: "Hide" },
    { view: "all", label: "Show" },
    { view: "only", label: "Only" },
  ];
  function pickIgnored(view: IgnoredView) {
    filter.ignored = view;
    changeFilter();
  }
  const TOGGLE_VIEWS: { view: ToggleView; label: string }[] = [
    { view: "all", label: "All" },
    { view: "on", label: "On" },
    { view: "off", label: "Off" },
  ];
  function pickToggle(control: BulkControl, view: ToggleView) {
    filter[control] = view;
    changeFilter();
  }
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
      return (
        failure?.error || `the server refused the change (status ${res.status})`
      );
    } catch (err) {
      return (err as Error).message;
    }
  }

  let busy = $state<Record<string, boolean>>({});
  const busyKey = (control: string, repo: Repo) => `${control}:${rowKey(repo)}`;

  // A bulk run passes quiet and reports one summary itself; a per-repo line
  // would be left over from an earlier repo in the batch. Both setters return
  // the failure text, or null on success.
  async function setAutoUpdate(
    repo: Repo,
    enabled: boolean,
    quiet = false,
  ): Promise<string | null> {
    const key = busyKey("auto", repo);
    busy[key] = true;
    if (!quiet)
      setStatus(
        `Turning auto-update ${enabled ? "on" : "off"} for ${repo.fullName}…`,
      );
    const failed = await post(
      `/api/v1/repos/auto-update-branch/${enabled ? "enable" : "disable"}`,
      { forge: repo.forge, fullName: repo.fullName },
    );
    delete busy[key];
    if (failed) {
      if (!quiet)
        setStatus(
          `Couldn't turn auto-update ${enabled ? "on" : "off"} for ${repo.fullName}: ${failed}`,
          "error",
        );
      return failed;
    }
    keep(repo);
    repo.autoUpdateBranch = enabled;
    if (!quiet)
      setStatus(
        `Auto-update turned ${enabled ? "on" : "off"} for ${repo.fullName}.`,
      );
    return null;
  }

  async function setRebaseBots(
    repo: Repo,
    enabled: boolean,
    quiet = false,
  ): Promise<string | null> {
    const key = busyKey("rebase", repo);
    busy[key] = true;
    if (!quiet)
      setStatus(
        `${enabled ? "Turning on" : "Turning off"} rebase bots for ${repo.fullName}…`,
      );
    const failed = await post(
      `/api/v1/repos/rebase-bots/${enabled ? "enable" : "disable"}`,
      { forge: repo.forge, fullName: repo.fullName },
    );
    delete busy[key];
    if (failed) {
      if (!quiet)
        setStatus(
          `Couldn't turn ${enabled ? "on" : "off"} rebase bots for ${repo.fullName}: ${failed}`,
          "error",
        );
      return failed;
    }
    keep(repo);
    repo.rebaseBots = enabled;
    if (!quiet)
      setStatus(`Rebase bots ${enabled ? "on" : "off"} for ${repo.fullName}.`);
    return null;
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
    keep(repo);
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
    keep(repo);
    repo.ignored = false;
    repo.ignoredPRs = false;
    repo.ignoredIssues = false;
    setStatus(`${repo.fullName} is no longer ignored.`);
  }

  // The bulk buttons act on the filtered list, every page of it, kept rows
  // included: what the person sees is what the button acts on, so narrowing
  // to "Auto-update off" and pressing "Turn on" does what it reads. With no
  // filter set that is every repo, and the label says "filtered" only when a
  // filter is cutting the list (#4857).
  const bulk = $derived({
    autoUpdateOn: bulkTargets(sortedRepos, "autoUpdate", true, rebaseBotsLock),
    autoUpdateOff: bulkTargets(
      sortedRepos,
      "autoUpdate",
      false,
      rebaseBotsLock,
    ),
    rebaseBotsOn: bulkTargets(sortedRepos, "rebaseBots", true, rebaseBotsLock),
    rebaseBotsOff: bulkTargets(
      sortedRepos,
      "rebaseBots",
      false,
      rebaseBotsLock,
    ),
  });
  const SKIP_LIST_MAX = 3;
  const REASON_MAX = 80;
  const shortReason = (reason: string) =>
    Array.from(reason).length > REASON_MAX
      ? `${Array.from(reason)
          .slice(0, REASON_MAX - 1)
          .join("")
          .trimEnd()}…`
      : reason;
  const plural = (n: number, word = "repo") =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  // What a bulk button reaches, in the button's own words.
  const reach = (n: number) =>
    filtersClear ? plural(n) : plural(n, "filtered repo");
  let bulkRunning = $state<string | null>(null);

  async function runBulk(
    control: BulkControl,
    enabled: boolean,
    targets: Repo[],
  ) {
    if (targets.length === 0) return;
    // Said as it was when pressed; a row toggled mid-run can't change it.
    const noun = filtersClear
      ? plural
      : (n: number) => plural(n, "filtered repo");
    const verb = enabled ? "on" : "off";
    const done =
      control === "autoUpdate"
        ? `Auto-update turned ${verb}`
        : `Rebase bots ${verb}`;
    const ok = window.confirm(
      control === "autoUpdate"
        ? `Turn ${verb} auto-update for ${noun(targets.length)}?`
        : `Turn ${verb} rebase bots for ${noun(targets.length)}?`,
    );
    if (!ok) return;
    bulkRunning = `${control}:${verb}`;
    setStatus(
      `${control === "autoUpdate" ? `Turning auto-update ${verb}` : `Turning ${verb} rebase bots`} for ${noun(targets.length)}…`,
    );
    const skipped: string[] = [];
    const reasons: string[] = [];
    for (const repo of targets) {
      const failed =
        control === "autoUpdate"
          ? await setAutoUpdate(repo, enabled, true)
          : await setRebaseBots(repo, enabled, true);
      if (failed) {
        reasons.push(failed);
        skipped.push(`${repo.fullName} (${shortReason(failed)})`);
      }
    }
    bulkRunning = null;
    const succeeded = targets.length - skipped.length;
    if (targets.length === 1) {
      const [repo] = targets;
      const [failed] = skipped;
      setStatus(
        failed
          ? `Couldn't ${control === "autoUpdate" ? `turn auto-update ${verb}` : `turn ${verb} rebase bots`} for ${repo.fullName}: ${shortReason(reasons[0])}`
          : `${done} for ${repo.fullName}.`,
        failed ? "error" : "",
      );
      return;
    }
    const shown = skipped.slice(0, SKIP_LIST_MAX).join(", ");
    const more =
      skipped.length > SKIP_LIST_MAX
        ? ` and ${skipped.length - SKIP_LIST_MAX} more`
        : "";
    setStatus(
      skipped.length === 0
        ? `${done} for all ${noun(succeeded)}.`
        : `${done} for ${succeeded} of ${noun(targets.length)}. ${skipped.length} skipped: ${shown}${more}.`,
      skipped.length === 0 ? "" : "error",
    );
  }

  const bulkButtons = $derived([
    {
      key: "autoUpdate:on",
      control: "autoUpdate",
      enabled: true,
      targets: bulk.autoUpdateOn,
      text: `Turn on auto-update for ${reach(bulk.autoUpdateOn.length)}`,
      busyText: "Turning auto-update on…",
    },
    {
      key: "autoUpdate:off",
      control: "autoUpdate",
      enabled: false,
      targets: bulk.autoUpdateOff,
      text: `Turn off auto-update for ${reach(bulk.autoUpdateOff.length)}`,
      busyText: "Turning auto-update off…",
    },
    {
      key: "rebaseBots:on",
      control: "rebaseBots",
      enabled: true,
      targets: bulk.rebaseBotsOn,
      text: `Rebase bots on for ${reach(bulk.rebaseBotsOn.length)}`,
      busyText: "Turning rebase bots on…",
    },
    {
      key: "rebaseBots:off",
      control: "rebaseBots",
      enabled: false,
      targets: bulk.rebaseBotsOff,
      text: `Rebase bots off for ${reach(bulk.rebaseBotsOff.length)}`,
      busyText: "Turning rebase bots off…",
    },
  ] as const);
</script>

<div id="repositories-section" aria-busy={awaiting ? "true" : undefined}>
  <ReadFailureAlert />
  <FirstRefreshStatus pending={showSkeleton} subject="repositories" srOnly />

  <p class="hint">
    Every tracked repo, and what the dashboard does for it. On each row the
    icons are Auto-update (merge arrows), Rebase bots (robot) and Ignore
    (crossed-out eye). Webhooks are set up on their own; a repo without one says
    why on its row, and the guide covers
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
      <div class="forge-scroll">
        <FilterGroup label="Ignored" id="repositories-ignored-filter">
          {#each IGNORED_VIEWS as { view, label } (view)}
            <FilterPill
              pressed={(filter.ignored ?? "active") === view}
              data-ignored-view={view}
              onclick={() => pickIgnored(view)}
            >
              {label}
            </FilterPill>
          {/each}
        </FilterGroup>
      </div>
      <div class="forge-scroll">
        <FilterGroup label="Auto-update" id="repositories-auto-update-filter">
          {#each TOGGLE_VIEWS as { view, label } (view)}
            <FilterPill
              pressed={(filter.autoUpdate ?? "all") === view}
              data-view={view}
              onclick={() => pickToggle("autoUpdate", view)}
            >
              {label}
            </FilterPill>
          {/each}
        </FilterGroup>
      </div>
      <div class="forge-scroll">
        <FilterGroup label="Rebase bots" id="repositories-rebase-bots-filter">
          {#each TOGGLE_VIEWS as { view, label } (view)}
            <FilterPill
              pressed={(filter.rebaseBots ?? "all") === view}
              data-view={view}
              onclick={() => pickToggle("rebaseBots", view)}
            >
              {label}
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
          oninput={() => changeFilter()}
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

    <p class="repo-count" id="repositories-count" aria-live="polite">
      {repoCountText(sortedRepos.length, repoScope(repos, filter, kept))}
    </p>

    {#if sortedRepos.length === 0}
      <p class="empty-state" id="repositories-no-results">
        No repos match these filters.{filter.ignored === "only" &&
        !repos.some((r) => r.ignored)
          ? " No repo is ignored."
          : ""}
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
            {@const scope = ignoreScopeOf(repo)}
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
                /><span class="repo-line-name">
                  {#if repo.url}<a
                      class="repo-link"
                      href={repo.url}
                      title={repo.fullName}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {repo.fullName}
                    </a>{:else}{repo.fullName}{/if}
                </span>
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
                {#if repo.ignored}
                  <span class="ignored-scope" data-testid="ignored-scope">
                    {ignoreScopeWords(scope)}
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
                  tip={toggleTip("Auto-update", repo.autoUpdateBranch)}
                  pressed={repo.autoUpdateBranch}
                  busy={busy[busyKey("auto", repo)]}
                  onclick={() => setAutoUpdate(repo, !repo.autoUpdateBranch)}
                />
              </td>
              <td role="cell" class="control-cell" data-label="Rebase bots">
                <RepoToggle
                  kind="rebase-bots"
                  name={rebaseBotsName(repo.fullName)}
                  tip={lockedOff
                    ? lockedTip("Rebase bots")
                    : toggleTip("Rebase bots", repo.rebaseBots)}
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
                  data-tip={ignoreTip(scope)}
                  use:tipDismiss
                >
                  <select
                    class="ignore-select"
                    data-ignored={scope ? "true" : undefined}
                    aria-busy={busy[busyKey("ignore", repo)]
                      ? "true"
                      : undefined}
                    aria-label={ignoreName(repo.fullName)}
                    disabled={busy[busyKey("ignore", repo)]}
                    value={scope}
                    onchange={async (e) => {
                      const select = e.currentTarget;
                      const next = select.value as IgnoreScope | "";
                      if (next) await ignoreRepo(repo, next);
                      else await unignoreRepo(repo);
                      // A failed save leaves the saved scope showing.
                      select.value = ignoreScopeOf(repo);
                    }}
                  >
                    <option value="">Not ignored</option>
                    {#each Object.entries(IGNORE_SCOPE_LABELS) as [value, label] (value)}
                      <option {value}>{label}</option>
                    {/each}
                  </select>
                  <span class="ignore-glyph">
                    <RepoControlIcon kind="ignore" />
                  </span>
                  {#if scope}
                    <svg
                      class="repo-check"
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <circle cx="8" cy="8" r="8" />
                      <path
                        d="m4.5 8.3 2.3 2.3 4.7-4.9"
                        fill="none"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  {/if}
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
    overflow-wrap: anywhere;
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
  .repo-count {
    margin: 0 0 10px;
    font-size: 0.78125rem;
    color: var(--ink-2);
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
  /* A long repo name wraps rather than widening the table past a narrow
     column (a tablet at large text, #4886). */
  .repo-table .name-cell {
    overflow-wrap: anywhere;
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
  .ignore-select[data-ignored="true"] {
    border-color: var(--pill-active);
    background: var(--pill-active);
  }
  .ignore-select[data-ignored="true"] + .ignore-glyph {
    color: var(--accent-ink);
  }
  .repo-check {
    position: absolute;
    right: 1px;
    bottom: 1px;
    fill: var(--accent-ink);
    stroke: var(--pill-active);
    pointer-events: none;
  }
  .ignored-scope {
    font-size: 0.75rem;
    color: var(--ink-2);
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
    /* One line per repo (#4858): forge marker, logo, name (cut with an
       ellipsis), then the three icons. The cells give up their boxes so the
       row's pieces are its flex items, and the failing, polling and lock
       notes drop below on a line of their own. Where the icons and the name
       can't share a line, the icons take one line under the name. */
    #repositories-rows {
      container: repo-rows / inline-size;
    }
    .repo-table tbody tr {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 2px 4px;
    }
    /* The logo and the badge's dot are decoration; on a phone the room goes
       to the name, which keeps at least 12 characters. */
    .repo-table .repo-logo,
    .repo-table .forge-badge .dot {
      display: none;
    }
    .repo-table td.name-cell,
    .repo-table td.control-cell {
      display: contents;
    }
    .repo-table td.control-cell::before {
      content: none;
    }
    .repo-table td[data-label="Forge"] {
      flex: none;
      padding: 0;
    }
    .repo-line-name {
      flex: 1 1 0;
      min-width: 12ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The ellipsis clips to the name, so the link's focus ring goes inside it. */
    .repo-line-name :global(.repo-link:focus-visible) {
      outline-offset: -2px;
    }
    .repo-table .failing-live,
    .repo-table .polling-reason,
    .repo-table .ignored-scope,
    .repo-table td.control-cell .lock-note {
      flex: 0 0 100%;
      order: 3;
      max-width: none;
      margin: 2px 0 0;
      text-align: left;
    }
    .ignore-select {
      width: 44px;
      height: 44px;
    }
    @container repo-rows (width <= 18.5rem) {
      .repo-table tbody tr::before {
        content: "";
        flex: 0 0 100%;
        height: 0;
        order: 1;
      }
      .repo-table td.control-cell > :global(.repo-control) {
        order: 2;
      }
    }
  }
</style>
