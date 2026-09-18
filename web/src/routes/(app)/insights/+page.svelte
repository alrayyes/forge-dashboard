<script lang="ts">
  import { onMount } from "svelte";

  type RateLimit = { limit: number; remaining: number; resetsAt: string };
  type Forge = {
    forge: string;
    reachable: boolean;
    repoCount: number;
    // GitHub tracks REST and GraphQL as two independent 5000/hour
    // budgets (#361) — this client spends both (the main repo/PR/issue
    // query is GraphQL; checkWebhooks and every write action are REST),
    // so one gauge was always only ever showing half the picture.
    rateLimitGraphQL?: RateLimit;
    rateLimitREST?: RateLimit;
  };

  // ---- shared filter state — the same cookie/object app.js reads and
  // writes (via the global Filters, filters.js), not a separate
  // preference store: filtering to a repo here or on the main dashboard
  // is one choice, not two independent ones. Only sharedState.shared
  // (forge/repo/label/author/title) and
  // sharedState.issue.hideDependencyDashboard apply here — created,
  // updated, and CI status are masked out below since each already has
  // its own chart on this page, and group-by never applied to Insights
  // at all (it's a row-layout choice with no equivalent for a chart).
  let sharedState = $state<SharedFilterState>({
    shared: {},
    pr: {},
    issue: { hideDependencyDashboard: "1" },
  });

  // Never lets created/updated leak into a chart just because the main
  // dashboard's own board has a value stored for them — see design.md's
  // "Insights keeps masking fields it doesn't display" decision.
  function chartFilters(): Record<string, string> {
    return { ...sharedState.shared, created: "", updated: "" };
  }

  const CI_STATES = [
    { key: "success", label: "Passing", className: "ci-good" },
    { key: "failure", label: "Failing", className: "ci-critical" },
    { key: "pending", label: "Running", className: "ci-warning" },
    { key: "none", label: "No checks", className: "ci-neutral" },
  ] as const;

  const REPO_RANK_CAP = 10;

  // Fixed age buckets, oldest-catch-all last so nothing older ever gets
  // dropped instead of counted.
  const AGE_BUCKETS = [
    { key: "lt1", label: "<1 day", maxHours: 24 },
    { key: "1to3", label: "1-3 days", maxHours: 24 * 3 },
    { key: "3to7", label: "3-7 days", maxHours: 24 * 7 },
    { key: "7to30", label: "7-30 days", maxHours: 24 * 30 },
    { key: "30plus", label: "30+ days", maxHours: Number.POSITIVE_INFINITY },
  ] as const;

  function bucketForAge(hoursOld: number): string {
    const bucket = AGE_BUCKETS.find((b) => hoursOld < b.maxHours);
    return bucket ? bucket.key : AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
  }

  function bucketAges(items: FilterableItem[]) {
    const counts: Record<string, number> = {};
    for (const b of AGE_BUCKETS) counts[b.key] = 0;
    const now = Date.now();
    for (const item of items) {
      const hoursOld =
        (now - new Date(item.createdAt).getTime()) / (60 * 60 * 1000);
      counts[bucketForAge(hoursOld)]++;
    }
    const maxCount = Math.max(...AGE_BUCKETS.map((b) => counts[b.key]));
    return { counts, maxCount };
  }

  // Ranked by count, single neutral hue — repo identity rides the label,
  // not a color, since a fixed categorical hue order doesn't scale past
  // a handful of repos.
  function rankByRepo(items: FilterableItem[]) {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.repo] = (counts[item.repo] || 0) + 1;
    const ranked = Object.keys(counts)
      .map((repo) => ({ repo, count: counts[repo] }))
      .sort((a, b) => b.count - a.count);
    const top = ranked.slice(0, REPO_RANK_CAP);
    const maxCount = top.length > 0 ? top[0].count : 0;
    const remaining = ranked.length - top.length;
    return { top, maxCount, remaining };
  }

  // Status thresholds on remaining%, not forge identity — --gh/--fj
  // don't pass as chart-mark fills (see the CSS comment on this card's
  // rules), and "how healthy is the budget" is the actually useful
  // signal here. Matches the 80%/95%-used amber/red split standard
  // rate-limit-UI guidance recommends (Speakeasy's rate-limiting
  // write-up, among others).
  function rateLimitStatusClass(remaining: number, limit: number): string {
    const pct = limit > 0 ? remaining / limit : 1;
    if (pct < 0.05) return "rl-critical";
    if (pct < 0.2) return "rl-warning";
    return "rl-good";
  }

  // Ticks once a second so "resets in Xm Ys" counts down live rather
  // than showing a fixed clock time a reader has to do their own
  // subtraction against — the same live-countdown pattern rate-limit
  // UIs are generally built around (a 429 dialog's own MM:SS retry
  // timer), not specific to this app.
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  function countdownLabel(resetsAt: string): string {
    const msLeft = new Date(resetsAt).getTime() - now;
    if (msLeft <= 0) return "resets any moment";
    const totalSeconds = Math.floor(msLeft / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0
      ? `resets in ${minutes}m ${seconds}s`
      : `resets in ${seconds}s`;
  }

  let lastSnapshot = $state<{
    pullRequests: FilterableItem[];
    issues: FilterableItem[];
    forges: Forge[];
  }>({ pullRequests: [], issues: [], forges: [] });

  const prItems = $derived(
    lastSnapshot.pullRequests.filter((item) =>
      window.Filters.matchesFilters(item, true, chartFilters(), undefined),
    ),
  );
  const issueItems = $derived(
    lastSnapshot.issues.filter((item) =>
      window.Filters.matchesFilters(
        item,
        false,
        chartFilters(),
        sharedState.issue,
      ),
    ),
  );

  const ciCounts = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const s of CI_STATES) counts[s.key] = 0;
    for (const p of prItems) {
      if (p.ci && Object.hasOwn(counts, p.ci)) counts[p.ci]++;
    }
    return counts;
  });

  const prRepoRanking = $derived.by(() => rankByRepo(prItems));
  const issueRepoRanking = $derived.by(() => rankByRepo(issueItems));
  const prAgeHistogram = $derived.by(() => bucketAges(prItems));
  const issueAgeHistogram = $derived.by(() => bucketAges(issueItems));

  function forgeScopedItems(): FilterableItem[] {
    const items = [...lastSnapshot.pullRequests, ...lastSnapshot.issues];
    if (!sharedState.shared.forge) return items;
    return items.filter((item) => item.forge === sharedState.shared.forge);
  }

  let sharedRepoSelect: HTMLSelectElement | undefined = $state();
  let sharedAuthorSelect: HTMLSelectElement | undefined = $state();
  let sharedLabelSelect: HTMLSelectElement | undefined = $state();
  let sharedTitleDatalist: HTMLDataListElement | undefined = $state();
  let filterBarEl: HTMLDivElement | undefined = $state();

  function updateSharedFilterOptions() {
    const scoped = forgeScopedItems();
    const staleRepo = window.Filters.populateRepoSelect(
      sharedRepoSelect ?? null,
      scoped,
    );
    const staleAuthor = window.Filters.populateSelect(
      sharedAuthorSelect ?? null,
      window.Filters.distinctValues((item) => item.author, scoped),
      sharedState.shared.author,
    );
    window.Filters.populateDatalist(
      sharedTitleDatalist ?? null,
      window.Filters.distinctValues((item) => item.title, scoped),
    );
    const staleLabel = window.Filters.populateSelect(
      sharedLabelSelect ?? null,
      window.Filters.distinctValues(
        (item) => (item.labels || []).map((l) => l.name),
        scoped,
      ),
      sharedState.shared.label,
    );
    if (staleRepo) sharedState.shared.repo = "";
    if (staleAuthor) sharedState.shared.author = "";
    if (staleLabel) sharedState.shared.label = "";
    if (staleRepo || staleAuthor || staleLabel)
      window.Filters.saveState(sharedState);
  }

  function syncSharedControlsToState() {
    if (!filterBarEl) return;
    filterBarEl
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>(".col-filter")
      .forEach((c) => {
        const value = sharedState.shared[(c as HTMLElement).dataset.col ?? ""];
        if (c instanceof HTMLInputElement && c.type === "radio") {
          c.checked = c.value === (value || "");
          return;
        }
        if (!value) return;
        if (c instanceof HTMLSelectElement) {
          const option = Array.from(c.options).find(
            (o) => o.value.toLowerCase() === value,
          );
          if (option) c.value = option.value;
        } else {
          c.value = value;
        }
      });
  }

  let sharedControlsRestored = false;

  function wireFilterBar() {
    filterBarEl
      ?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".col-filter")
      .forEach((c) => {
        const apply = () => {
          const col = (c as HTMLElement).dataset.col ?? "";
          const value =
            c instanceof HTMLInputElement && c.type === "radio"
              ? c.value
              : c.value.trim().toLowerCase();
          sharedState.shared[col] = value;
          if (col === "forge") updateSharedFilterOptions();
          window.Filters.saveState(sharedState, col);
        };
        c.addEventListener("input", apply);
        c.addEventListener("change", apply);
      });
  }

  // Matches sharedState's own initial default above — resynced from the
  // real cookie/server value once filters.js has loaded, in onMount.
  let hideDependencyDashboard = $state(true);

  function toggleHideDependencyDashboard() {
    sharedState.issue.hideDependencyDashboard = hideDependencyDashboard
      ? "1"
      : "";
    window.Filters.saveState(sharedState);
  }

  onMount(() => {
    // filters.js loads asynchronously (a real <script src>, same as
    // footer.js/nav.js) — everything that touches window.Filters has to
    // wait for it, so the rest of this page's own setup runs from its
    // onload rather than synchronously here.
    const filtersScript = document.createElement("script");
    filtersScript.src = "/filters.js";
    filtersScript.addEventListener("load", () => {
      sharedState = window.Filters.loadState();
      hideDependencyDashboard =
        sharedState.issue.hideDependencyDashboard === "1";
      wireFilterBar();

      // #353: the same cross-device reconciliation app.js's own copy of
      // this does — see its comment for the full reasoning. Insights and
      // the main dashboard share the one saved filter state, so this
      // page has to pull it too rather than only ever seeing whatever
      // the cookie already has.
      window.Filters.loadStateFromServer().then((got) => {
        if (got) window.Filters.applyServerState(sharedState, got);
        hideDependencyDashboard =
          sharedState.issue.hideDependencyDashboard === "1";
        if (sharedControlsRestored) {
          updateSharedFilterOptions();
          syncSharedControlsToState();
        }
      });

      fetch("/api/dashboard", { headers: { Accept: "application/json" } })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = "/login.html";
            throw new Error("session expired");
          }
          if (!res.ok) throw new Error(`backend answered ${res.status}`);
          return res.json();
        })
        .then(
          (data: {
            pullRequests?: FilterableItem[];
            issues?: FilterableItem[];
            forges?: Forge[];
          }) => {
            lastSnapshot.pullRequests = data.pullRequests || [];
            lastSnapshot.issues = data.issues || [];
            lastSnapshot.forges = data.forges || [];
            updateSharedFilterOptions();
            if (!sharedControlsRestored) {
              sharedControlsRestored = true;
              syncSharedControlsToState();
            }
          },
        )
        .catch(() => {
          // A transient failure here just leaves the empty states
          // showing — the dashboard page itself is where a real error
          // banner belongs.
        });
    });
    document.body.appendChild(filtersScript);

    for (const src of ["/footer.js", "/nav.js"]) {
      const script = document.createElement("script");
      script.src = src;
      document.body.appendChild(script);
    }
  });
</script>

<svelte:head>
  <title>Insights — Forge Board</title>
  <style>
    .insights-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .insights-header {
      margin-bottom: 22px;
    }
    .insights-header h1 {
      font-size: 19px;
      margin: 0;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 22px 22px 20px;
      margin-bottom: 18px;
    }
    .card h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ink-2);
      margin: 0 0 4px;
    }
    .card .hint {
      font-size: 12.5px;
      color: var(--ink-3);
      margin: 0 0 16px;
    }
    .empty-state {
      font-size: 12.5px;
      color: var(--ink-3);
      margin: 0;
    }

    /* ---- CI status bar chart ---- */
    /* <= 24px thick per the house dataviz mark spec; the two-space gap
       between rows is what separates them, not a border. */
    .ci-bars {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 0 0 18px;
    }
    .ci-bar-row {
      display: grid;
      grid-template-columns: 88px 1fr 32px;
      align-items: center;
      gap: 10px;
    }
    .ci-bar-label {
      font-size: 12.5px;
      color: var(--ink-2);
    }
    .ci-bar-track {
      height: 16px;
      border-radius: 8px;
      background: var(--surface-sunken);
      overflow: hidden;
    }
    .ci-bar-fill {
      height: 100%;
      border-radius: 8px;
      min-width: 2px;
    }
    .ci-bar-fill.ci-good {
      background: var(--good);
    }
    .ci-bar-fill.ci-critical {
      background: var(--critical);
    }
    .ci-bar-fill.ci-warning {
      background: var(--warning);
    }
    .ci-bar-fill.ci-neutral {
      background: var(--neutral);
    }
    .ci-count {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12.5px;
      color: var(--ink);
      text-align: right;
    }

    /* Present alongside the chart, not hidden behind it — a chart is
       never the only way to read the numbers here. */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    .data-table th,
    .data-table td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    .data-table th {
      color: var(--ink-2);
      font-weight: 500;
    }
    .data-table td.num {
      text-align: right;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }

    /* ---- repo ranking (single neutral hue — repo identity rides the
       label, not a color, since a fixed categorical hue order doesn't
       scale past a handful of repos) ---- */
    .rank-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    @media (max-width: 560px) {
      .rank-columns {
        grid-template-columns: 1fr;
      }
    }
    .rank-columns h3 {
      font-size: 12px;
      color: var(--ink-3);
      margin: 0 0 10px;
      font-weight: 500;
    }
    .rank-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 0 0 8px;
    }
    .rank-row {
      display: grid;
      grid-template-columns: 1fr 28px;
      align-items: center;
      gap: 8px;
    }
    .rank-label {
      font-size: 12.5px;
      color: var(--ink-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rank-track {
      grid-column: 1 / -1;
      height: 8px;
      border-radius: 4px;
      background: var(--surface-sunken);
      overflow: hidden;
    }
    .rank-fill {
      height: 100%;
      border-radius: 4px;
      min-width: 2px;
      background: var(--neutral);
    }
    .rank-count {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12.5px;
      color: var(--ink);
      text-align: right;
    }
    .rank-more {
      font-size: 11.5px;
      color: var(--ink-3);
      margin: 4px 0 0;
    }

    /* ---- pull request age histogram — one sequential hue, a magnitude
       encoding, not identity ---- */
    .age-bars {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 0 0 18px;
    }
    .age-bar-row {
      display: grid;
      grid-template-columns: 88px 1fr 32px;
      align-items: center;
      gap: 10px;
    }
    .age-bar-label {
      font-size: 12.5px;
      color: var(--ink-2);
    }
    .age-bar-track {
      height: 16px;
      border-radius: 8px;
      background: var(--surface-sunken);
      overflow: hidden;
    }
    .age-bar-fill {
      height: 100%;
      border-radius: 8px;
      min-width: 2px;
      background: var(--accent);
    }
    .age-count {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12.5px;
      color: var(--ink);
      text-align: right;
    }

    /* ---- rate-limit headroom — colored by status (how healthy the
       budget is), never by forge identity: --gh/--fj don't pass as
       chart-mark fills (validated against the house dataviz palette
       checker — they were designed as badge text/background, not data
       marks) ---- */
    .rate-limit-row {
      margin: 0 0 18px;
    }
    .rate-limit-row:last-child {
      margin-bottom: 0;
    }
    .rate-limit-forge-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--ink);
      margin: 0 0 8px;
    }
    .rate-limit-budgets {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    @media (max-width: 480px) {
      .rate-limit-budgets {
        grid-template-columns: 1fr;
      }
    }
    .rate-limit-budget {
      border-radius: 8px;
    }
    /* Exhausted reads as an alert, not just a colored bar — the same
       "more prominent than a subtle fill" treatment the dashboard's own
       CI-failing stat tile gets, borrowed here since a fully drained
       budget is exactly as actionable as CI failing is. */
    .rate-limit-budget.rl-exhausted {
      background: var(--critical-bg);
      border: 1px solid var(--critical);
      padding: 8px 10px;
    }
    .rate-limit-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
    }
    .rate-limit-forge {
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ink-3);
      font-weight: 500;
    }
    .rate-limit-count {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12.5px;
      color: var(--ink);
    }
    .rate-limit-budget.rl-exhausted .rate-limit-forge,
    .rate-limit-budget.rl-exhausted .rate-limit-count {
      color: var(--critical);
      font-weight: 600;
    }
    .rate-limit-bar {
      height: 16px;
      border-radius: 8px;
      background: var(--surface-sunken);
      overflow: hidden;
    }
    .rate-limit-fill {
      height: 100%;
      border-radius: 8px;
      min-width: 2px;
    }
    .rate-limit-fill.rl-good {
      background: var(--good);
    }
    .rate-limit-fill.rl-warning {
      background: var(--warning);
    }
    .rate-limit-fill.rl-critical {
      background: var(--critical);
    }
    .rate-limit-reset {
      font-size: 11.5px;
      color: var(--ink-3);
      margin: 4px 0 0;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .rate-limit-budget.rl-exhausted .rate-limit-reset {
      color: var(--critical);
    }
    .rate-limit-note {
      font-size: 12.5px;
      color: var(--ink-3);
    }

    /* ---- filters — one row above the content it scopes, same as the
       dataviz house rule. .filter-bar and .forge-segmented themselves
       come from style.css, shared with the main dashboard's own filter
       bar. ---- */
    .issue-only-filter {
      margin: 10px 0 0;
    }
  </style>
</svelte:head>

<div class="insights-wrap">
  <div class="insights-header">
    <h1>Insights</h1>
  </div>

  <div class="card">
    <h2>Filters</h2>
    <p class="hint">
      Scope every chart below — shared with the main dashboard's own filters, so
      a choice made either place carries over. Created, updated, CI status, and
      grouping aren't here: each of the first three already has its own chart
      below, and grouping has no equivalent for a chart.
    </p>

    <div
      class="filter-bar"
      role="search"
      aria-label="Filter Insights charts"
      bind:this={filterBarEl}
    >
      <fieldset class="forge-segmented">
        <legend class="sr-only">Filter by forge</legend>
        <label>
          <input
            type="radio"
            name="forge"
            class="col-filter"
            data-col="forge"
            value=""
            checked
          />
          <span>All</span>
        </label>
        <label>
          <input
            type="radio"
            name="forge"
            class="col-filter"
            data-col="forge"
            value="github"
          />
          <span>GitHub</span>
        </label>
        <label>
          <input
            type="radio"
            name="forge"
            class="col-filter"
            data-col="forge"
            value="forgejo"
          />
          <span>Forgejo</span>
        </label>
      </fieldset>
      <select
        class="col-filter"
        data-col="repo"
        id="shared-repo-select"
        aria-label="Filter by repo"
        bind:this={sharedRepoSelect}
      >
        <option value="">All repos</option>
      </select>
      <input
        class="col-filter"
        data-col="title"
        type="text"
        placeholder="Title"
        aria-label="Filter by title"
        list="shared-title-options"
        autocomplete="off"
      />
      <datalist id="shared-title-options" bind:this={sharedTitleDatalist}
      ></datalist>
      <select
        class="col-filter"
        data-col="author"
        id="shared-author-select"
        aria-label="Filter by author"
        bind:this={sharedAuthorSelect}
      >
        <option value="">All authors</option>
      </select>
      <select
        class="col-filter"
        data-col="label"
        id="shared-label-select"
        aria-label="Filter by label"
        bind:this={sharedLabelSelect}
      >
        <option value="">All labels</option>
      </select>
    </div>

    <label class="checkbox-filter issue-only-filter">
      <input
        type="checkbox"
        id="issue-hide-dependency-dashboard"
        bind:checked={hideDependencyDashboard}
        onchange={toggleHideDependencyDashboard}
      />
      Hide Dependency Dashboard (issue charts only)
    </label>
  </div>

  <div class="card">
    <h2>CI status</h2>
    <p class="hint">
      The combined check result across every currently open pull request — the
      same counts the dashboard's own tiles show, broken out by state.
    </p>

    {#if prItems.length === 0}
      <p class="empty-state" id="ci-status-empty">No open pull requests.</p>
    {:else}
      <div class="ci-bars" id="ci-status-chart">
        {#each CI_STATES as state (state.key)}
          {@const count = ciCounts[state.key]}
          {@const pct = prItems.length > 0 ? (count / prItems.length) * 100 : 0}
          <div class="ci-bar-row" data-ci-status={state.key}>
            <span class="ci-bar-label">{state.label}</span>
            <div class="ci-bar-track">
              <div
                class={`ci-bar-fill ${state.className}`}
                style={`width: ${pct}%`}
              ></div>
            </div>
            <span class="ci-count">{count}</span>
          </div>
        {/each}
      </div>

      <table class="data-table" id="ci-status-table">
        <caption class="sr-only"
          >CI status counts across open pull requests</caption
        >
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {#each CI_STATES as state (state.key)}
            <tr>
              <td>{state.label}</td>
              <td class="num">{ciCounts[state.key]}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="card">
    <h2>Busiest repos</h2>
    <p class="hint">
      Tracked repos ranked by how many open pull requests and issues they
      currently have — up to the ten busiest of each.
    </p>

    <div class="rank-columns">
      <section aria-labelledby="repo-pr-ranking-heading">
        <h3 id="repo-pr-ranking-heading">Pull requests</h3>
        {#if prRepoRanking.top.length === 0}
          <p class="empty-state" id="repo-pr-ranking-empty">
            No open pull requests.
          </p>
        {:else}
          <div class="rank-list" id="repo-pr-ranking">
            {#each prRepoRanking.top as entry (entry.repo)}
              <div class="rank-row">
                <span class="rank-label" title={entry.repo}>{entry.repo}</span>
                <span class="rank-count">{entry.count}</span>
                <div class="rank-track">
                  <div
                    class="rank-fill"
                    style={`width: ${prRepoRanking.maxCount > 0 ? (entry.count / prRepoRanking.maxCount) * 100 : 0}%`}
                  ></div>
                </div>
              </div>
            {/each}
          </div>
          {#if prRepoRanking.remaining > 0}
            <p class="rank-more" id="repo-pr-ranking-more">
              +{prRepoRanking.remaining} more
            </p>
          {/if}
        {/if}
      </section>
      <section aria-labelledby="repo-issue-ranking-heading">
        <h3 id="repo-issue-ranking-heading">Issues</h3>
        {#if issueRepoRanking.top.length === 0}
          <p class="empty-state" id="repo-issue-ranking-empty">
            No open issues.
          </p>
        {:else}
          <div class="rank-list" id="repo-issue-ranking">
            {#each issueRepoRanking.top as entry (entry.repo)}
              <div class="rank-row">
                <span class="rank-label" title={entry.repo}>{entry.repo}</span>
                <span class="rank-count">{entry.count}</span>
                <div class="rank-track">
                  <div
                    class="rank-fill"
                    style={`width: ${issueRepoRanking.maxCount > 0 ? (entry.count / issueRepoRanking.maxCount) * 100 : 0}%`}
                  ></div>
                </div>
              </div>
            {/each}
          </div>
          {#if issueRepoRanking.remaining > 0}
            <p class="rank-more" id="repo-issue-ranking-more">
              +{issueRepoRanking.remaining} more
            </p>
          {/if}
        {/if}
      </section>
    </div>
  </div>

  <div class="card">
    <h2>Pull request age</h2>
    <p class="hint">
      How long currently open pull requests have been sitting — a stale one
      stands out here instead of just in its own row's timestamp.
    </p>

    {#if prItems.length === 0}
      <p class="empty-state" id="pr-age-empty">No open pull requests.</p>
    {:else}
      <div class="age-bars" id="pr-age-chart">
        {#each AGE_BUCKETS as bucket (bucket.key)}
          {@const count = prAgeHistogram.counts[bucket.key]}
          {@const pct =
            prAgeHistogram.maxCount > 0
              ? (count / prAgeHistogram.maxCount) * 100
              : 0}
          <div class="age-bar-row" data-age-bucket={bucket.key}>
            <span class="age-bar-label">{bucket.label}</span>
            <div class="age-bar-track">
              <div class="age-bar-fill" style={`width: ${pct}%`}></div>
            </div>
            <span class="age-count">{count}</span>
          </div>
        {/each}
      </div>

      <table class="data-table" id="pr-age-table">
        <caption class="sr-only">Open pull request counts by age</caption>
        <thead>
          <tr>
            <th scope="col">Age</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {#each AGE_BUCKETS as bucket (bucket.key)}
            <tr>
              <td>{bucket.label}</td>
              <td class="num">{prAgeHistogram.counts[bucket.key]}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="card">
    <h2>Issue age</h2>
    <p class="hint">Same idea as pull request age, for open issues.</p>

    {#if issueItems.length === 0}
      <p class="empty-state" id="issue-age-empty">No open issues.</p>
    {:else}
      <div class="age-bars" id="issue-age-chart">
        {#each AGE_BUCKETS as bucket (bucket.key)}
          {@const count = issueAgeHistogram.counts[bucket.key]}
          {@const pct =
            issueAgeHistogram.maxCount > 0
              ? (count / issueAgeHistogram.maxCount) * 100
              : 0}
          <div class="age-bar-row" data-age-bucket={bucket.key}>
            <span class="age-bar-label">{bucket.label}</span>
            <div class="age-bar-track">
              <div class="age-bar-fill" style={`width: ${pct}%`}></div>
            </div>
            <span class="age-count">{count}</span>
          </div>
        {/each}
      </div>

      <table class="data-table" id="issue-age-table">
        <caption class="sr-only">Open issue counts by age</caption>
        <thead>
          <tr>
            <th scope="col">Age</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {#each AGE_BUCKETS as bucket (bucket.key)}
            <tr>
              <td>{bucket.label}</td>
              <td class="num">{issueAgeHistogram.counts[bucket.key]}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="card">
    <h2>API rate limits</h2>
    <p class="hint">
      How much of each forge's request budget is left before a refresh starts
      failing. Not every forge reports one — Forgejo doesn't by default.
    </p>

    {#snippet rateLimitBudget(kind: string, rl: RateLimit | undefined)}
      {#if !rl}
        <div class="rate-limit-budget">
          <div class="rate-limit-head">
            <span class="rate-limit-forge">{kind}</span>
          </div>
          <p class="rate-limit-note">Not reported.</p>
        </div>
      {:else}
        {@const pct = rl.limit > 0 ? (rl.remaining / rl.limit) * 100 : 0}
        {@const statusClass = rateLimitStatusClass(rl.remaining, rl.limit)}
        {@const exhausted = rl.remaining === 0}
        <div
          class={`rate-limit-budget${exhausted ? " rl-exhausted" : ""}`}
          data-rate-limit-kind={kind}
        >
          <div class="rate-limit-head">
            <span class="rate-limit-forge">{kind}</span>
            <span class="rate-limit-count"
              >{rl.remaining.toLocaleString()} / {rl.limit.toLocaleString()} requests</span
            >
          </div>
          <div class="rate-limit-bar">
            <div
              class={`rate-limit-fill ${statusClass}`}
              style={`width: ${pct}%`}
            ></div>
          </div>
          <p class="rate-limit-reset">
            {exhausted ? "Rate limit exceeded — " : ""}{countdownLabel(
              rl.resetsAt,
            )}
          </p>
        </div>
      {/if}
    {/snippet}

    <div id="rate-limit-list">
      {#each lastSnapshot.forges as f (f.forge)}
        {@const label = window.Filters?.FORGE_LABELS[f.forge] || f.forge}
        <div class="rate-limit-row" data-forge={f.forge}>
          <h3 class="rate-limit-forge-name">{label}</h3>
          <div class="rate-limit-budgets">
            {@render rateLimitBudget("GraphQL", f.rateLimitGraphQL)}
            {@render rateLimitBudget("REST", f.rateLimitREST)}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <footer>
    Read-only mirror of both forges &middot; credentials never leave <span
      class="mono">forge-dashboard</span
    >'s backend &middot;
    <a
      href="https://github.com/alrayyes/forge-dashboard"
      target="_blank"
      rel="noopener noreferrer">Source</a
    >
    <span id="footer-version"></span>
  </footer>
</div>
