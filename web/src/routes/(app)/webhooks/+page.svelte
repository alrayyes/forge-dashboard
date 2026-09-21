<script lang="ts">
  import { onMount } from "svelte";

  type RateLimit = { limit: number; remaining: number; resetsAt: string };
  // Webhook management (list/create/edit a hook) is REST-only (#361) —
  // rateLimitGraphQL exists on the real ForgeHealth this page reads but
  // is deliberately not modeled here at all, the same restraint that
  // kept this page's own FORGE_LABELS local instead of reaching for the
  // shared window.Filters one.
  type ForgeHealthEntry = { forge: string; rateLimitREST?: RateLimit };
  type Repo = {
    forge: string;
    fullName: string;
    url?: string;
    hasWebhook: boolean;
    canManageWebhooks?: boolean;
    ignored: boolean;
    ignoredPRs: boolean;
    ignoredIssues: boolean;
    autoUpdateBranch: boolean;
  };

  // The three choices POST /api/repos/ignore's scope maps to (#511) — a
  // plain union rather than two separate booleans in the UI layer, since
  // "neither" isn't a fourth choice here: it's not ignoring at all, which
  // is un-ignore's job, not this control's.
  type IgnoreScope = "prs" | "issues" | "both";
  const IGNORE_SCOPE_LABELS: Record<IgnoreScope, string> = {
    prs: "Ignore PRs",
    issues: "Ignore issues",
    both: "Ignore both",
  };

  // Kept local rather than reaching into the shared /filters.js global
  // (window.Filters.FORGE_LABELS, loaded by the dashboard and Insights
  // pages) — it's a two-entry map, and duplicating that is cheaper than
  // depending on that ambient type just for this.
  const FORGE_LABELS: Record<string, string> = {
    github: "GitHub",
    forgejo: "Forgejo",
  };
  const FORGE_CLASSES: Record<string, string> = { github: "gh", forgejo: "fj" };

  const ERROR_HEADLINES: Record<number, string> = {
    400: "That repo name doesn't look right.",
    404: "Repo not found on the forge — check it still exists.",
    409: "The forge rejected this — see details.",
  };

  // `status: number | undefined`, not `status?: number` — this pinned
  // vite/rolldown/svelte combo's TS parser (oxc) chokes on optional-
  // parameter syntax inside a Svelte <script lang="ts"> block, confirmed
  // via an isolated repro; the equivalent explicit-undefined form works.
  function webhookErrorHeadline(status: number | undefined): string {
    return (
      (status && ERROR_HEADLINES[status]) ||
      "Something went wrong creating the webhook."
    );
  }

  // reactiveLockReason maps a failed /api/webhooks/ensure response to a
  // reason worth locking the button over, or null for anything retrying
  // might fix (a genuine outage, say) — the two status codes
  // clientErrorStatus (internal/api/webhook_ensure.go) hands back for a
  // cause a click can't do anything about.
  function reactiveLockReason(status: number | undefined): string | null {
    if (status === 403)
      return "Missing permission — check your token in Settings.";
    if (status === 429)
      return "Rate limit exceeded — try again once it resets.";
    return null;
  }

  function resetTimeLabel(iso: string): string {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function rowKey(repo: Repo): string {
    return `${repo.forge}:${repo.fullName}`;
  }

  let loaded = $state(false);
  let repos = $state<Repo[]>([]);
  let forges = $state<ForgeHealthEntry[]>([]);

  let filterForge = $state("");
  let filterRepo = $state("");
  let filterStatus = $state("");
  let sortKey = $state<"forge" | "fullName" | "hasWebhook">("fullName");
  let sortDir = $state<"asc" | "desc">("asc");
  let page = $state(1);
  let pageSize = $state(25);

  let statusMessage = $state("");
  let statusKind = $state<"" | "error">("");
  let statusDetail = $state("");

  type RowUiState = { adding?: boolean; lockReason?: string };
  let rowState = $state<Record<string, RowUiState>>({});

  function rateLimitLock(forge: string): string | null {
    const f = forges.find((f) => f.forge === forge);
    if (f?.rateLimitREST && f.rateLimitREST.remaining === 0) {
      return `Rate limit exhausted · resets ${resetTimeLabel(f.rateLimitREST.resetsAt)}`;
    }
    return null;
  }

  function lockReasonFor(repo: Repo): string | null {
    return rowState[rowKey(repo)]?.lockReason ?? rateLimitLock(repo.forge);
  }

  // Ignored repos (#363) have their own "Ignored (N)" disclosure below
  // rather than cluttering this table's default view alongside every
  // repo that still matters day to day — un-ignoring one is what brings
  // it back here, not a filter toggle.
  const ignoredRepos = $derived(repos.filter((r) => r.ignored));

  // #380: every currently-tracked repo missing a webhook, regardless of
  // the active filter bar — the bulk action's whole point is doing every
  // one at once, not whatever the view happens to be scoped to right
  // now. Excludes a repo the user can't manage webhooks on at all
  // (canManageWebhooks false): nothing a bulk click could fix there
  // either, same reason the per-row action cell already shows the
  // "needs admin access" explanation instead of a button for it.
  const reposNeedingWebhook = $derived(
    repos.filter((r) => !r.ignored && r.canManageWebhooks && !r.hasWebhook),
  );

  let bulkRunning = $state(false);

  // Reuses addWebhook (defined below) for every target, one at a time —
  // the same endpoint and the same per-row error handling a single click
  // already gets (a locked reason, a retry-able message) rather than a
  // new bulk-specific code path, so a repo that fails mid-batch shows up
  // exactly the way an individual failed click already would, right on
  // its own row, without needing a separate summary UI to duplicate it.
  async function addAllWebhooks() {
    const targets = reposNeedingWebhook;
    if (targets.length === 0) return;

    const confirmed = window.confirm(
      `Set up a webhook on ${targets.length} repo${targets.length === 1 ? "" : "s"} missing one?`,
    );
    if (!confirmed) return;

    bulkRunning = true;
    for (const repo of targets) {
      await addWebhook(repo);
    }
    bulkRunning = false;

    const succeeded = targets.filter((r) => r.hasWebhook).length;
    const failed = targets.length - succeeded;
    setStatus(
      failed === 0
        ? `Set up webhooks for all ${succeeded} repos.`
        : `Set up webhooks for ${succeeded} of ${targets.length} repos — ${failed} failed, see the affected row${failed === 1 ? "" : "s"} above.`,
      failed === 0 ? "" : "error",
    );
  }

  const filteredRepos = $derived(
    repos.filter((r) => {
      if (r.ignored) return false;
      if (filterForge && r.forge !== filterForge) return false;
      if (
        filterRepo &&
        !r.fullName.toLowerCase().includes(filterRepo.toLowerCase())
      ) {
        return false;
      }
      if (filterStatus === "confirmed" && !r.hasWebhook) return false;
      if (filterStatus === "pending" && r.hasWebhook) return false;
      return true;
    }),
  );

  function sortValue(repo: Repo, key: string): string | number {
    if (key === "hasWebhook") return repo.hasWebhook ? 1 : 0;
    return (repo as unknown as Record<string, string>)[key];
  }

  const sortedRepos = $derived(
    filteredRepos.slice().sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    }),
  );

  const totalPages = $derived(
    Math.max(1, Math.ceil(sortedRepos.length / pageSize)),
  );
  const clampedPage = $derived(Math.min(page, totalPages));
  const pageItems = $derived(
    sortedRepos.slice(
      (clampedPage - 1) * pageSize,
      (clampedPage - 1) * pageSize + pageSize,
    ),
  );
  const pageNumbers = $derived(
    Array.from({ length: totalPages }, (_, i) => i + 1),
  );

  function setSort(key: "forge" | "fullName" | "hasWebhook") {
    if (sortKey === key) {
      sortDir = sortDir === "desc" ? "asc" : "desc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
    page = 1;
  }

  function onFilterChange() {
    page = 1;
  }

  function setStatus(message: string, kind: "" | "error" = "", detail = "") {
    statusMessage = message;
    statusKind = kind;
    statusDetail = detail;
  }

  async function addWebhook(repo: Repo) {
    const key = rowKey(repo);
    rowState[key] = { adding: true };
    setStatus(`Adding a webhook for ${repo.fullName}…`);

    try {
      const res = await fetch("/api/webhooks/ensure", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ forge: repo.forge, fullName: repo.fullName }),
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        const err: Error & { status?: number } = new Error(
          body?.error || `backend answered ${res.status}`,
        );
        err.status = res.status;
        throw err;
      }
      repo.hasWebhook = true;
      rowState[key] = {};
      setStatus(`Webhook added for ${repo.fullName}.`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const lockReason = reactiveLockReason(status);
      if (lockReason) {
        rowState[key] = { lockReason };
        setStatus(`Couldn't add a webhook for ${repo.fullName}.`, "error");
        return;
      }
      rowState[key] = {};
      setStatus(
        `Couldn't add a webhook for ${repo.fullName}: ${webhookErrorHeadline(status)}`,
        "error",
        (err as Error).message,
      );
    }
  }

  let ignoreBusy = $state<Record<string, boolean>>({});

  const IGNORE_SCOPE_DESCRIPTIONS: Record<IgnoreScope, string> = {
    prs: "its pull requests won't show on the dashboard or Insights",
    issues: "its issues won't show on the dashboard or Insights",
    both: "its pull requests and issues won't show on the dashboard or Insights",
  };

  // Reversible, not destructive (#363's own design decision): no confirm
  // step, the same as addWebhook above — a pure local write, never
  // touching the forge, so there's nothing here a retry can't undo. A
  // repeat call with a different scope (#511) replaces the saved scope
  // rather than adding to it, matching POST /api/repos/ignore's own
  // documented behavior.
  async function ignoreRepo(repo: Repo, scope: IgnoreScope) {
    const key = rowKey(repo);
    ignoreBusy[key] = true;
    setStatus(`Ignoring ${repo.fullName}…`);

    try {
      const res = await fetch("/api/repos/ignore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          forge: repo.forge,
          fullName: repo.fullName,
          prs: scope === "prs" || scope === "both",
          issues: scope === "issues" || scope === "both",
        }),
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `backend answered ${res.status}`);
      }
      repo.ignored = true;
      repo.ignoredPRs = scope === "prs" || scope === "both";
      repo.ignoredIssues = scope === "issues" || scope === "both";
      setStatus(
        `${repo.fullName} is now ignored — ${IGNORE_SCOPE_DESCRIPTIONS[scope]}.`,
      );
    } catch (err) {
      setStatus(
        `Couldn't ignore ${repo.fullName}: ${(err as Error).message}`,
        "error",
      );
    } finally {
      delete ignoreBusy[key];
    }
  }

  // Un-ignore always clears both scopes at once (#511's own decision — no
  // per-scope un-ignore in this pass): the "Ignored" disclosure shows one
  // repo per row regardless of scope, so a single Un-ignore there means
  // "stop ignoring this repo", not "stop ignoring whichever scope I
  // happened to click".
  async function unignoreRepo(repo: Repo) {
    const key = rowKey(repo);
    ignoreBusy[key] = true;
    setStatus(`Un-ignoring ${repo.fullName}…`);

    try {
      const res = await fetch("/api/repos/unignore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ forge: repo.forge, fullName: repo.fullName }),
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `backend answered ${res.status}`);
      }
      repo.ignored = false;
      repo.ignoredPRs = false;
      repo.ignoredIssues = false;
      setStatus(`${repo.fullName} is no longer ignored.`);
    } catch (err) {
      setStatus(
        `Couldn't un-ignore ${repo.fullName}: ${(err as Error).message}`,
        "error",
      );
    } finally {
      delete ignoreBusy[key];
    }
  }

  let autoUpdateBusy = $state<Record<string, boolean>>({});

  // Mirrors ignoreRepo/unignoreRepo above: a pure per-user setting write,
  // nothing touching the forge, so a global status message is enough — no
  // per-row locked-reason mechanic the way addWebhook needs one.
  async function setAutoUpdateBranch(repo: Repo, enabled: boolean) {
    const key = rowKey(repo);
    autoUpdateBusy[key] = true;
    const verb = enabled ? "Enabling" : "Disabling";
    setStatus(`${verb} auto-update-branch for ${repo.fullName}…`);

    try {
      const res = await fetch(
        `/api/repos/auto-update-branch/${enabled ? "enable" : "disable"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ forge: repo.forge, fullName: repo.fullName }),
        },
      );
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `backend answered ${res.status}`);
      }
      repo.autoUpdateBranch = enabled;
      setStatus(
        enabled
          ? `Auto-update-branch enabled for ${repo.fullName}.`
          : `Auto-update-branch disabled for ${repo.fullName}.`,
      );
    } catch (err) {
      setStatus(
        `Couldn't ${enabled ? "enable" : "disable"} auto-update-branch for ${repo.fullName}: ${(err as Error).message}`,
        "error",
      );
    } finally {
      delete autoUpdateBusy[key];
    }
  }

  // Same bulk shape as reposNeedingWebhook/addAllWebhooks (#380): every
  // currently-tracked, non-ignored repo on the wrong side of the target
  // state, regardless of the active filter bar.
  const reposMissingAutoUpdate = $derived(
    repos.filter((r) => !r.ignored && !r.autoUpdateBranch),
  );
  const reposWithAutoUpdate = $derived(
    repos.filter((r) => !r.ignored && r.autoUpdateBranch),
  );

  let bulkAutoUpdateDirection = $state<"enable" | "disable" | null>(null);

  async function bulkSetAutoUpdateBranch(enabled: boolean) {
    const targets = enabled ? reposMissingAutoUpdate : reposWithAutoUpdate;
    if (targets.length === 0) return;

    const verb = enabled ? "Enable" : "Disable";
    const confirmed = window.confirm(
      `${verb} auto-update-branch on ${targets.length} repo${targets.length === 1 ? "" : "s"}?`,
    );
    if (!confirmed) return;

    bulkAutoUpdateDirection = enabled ? "enable" : "disable";
    for (const repo of targets) {
      await setAutoUpdateBranch(repo, enabled);
    }
    bulkAutoUpdateDirection = null;

    const succeeded = targets.filter(
      (r) => r.autoUpdateBranch === enabled,
    ).length;
    const failed = targets.length - succeeded;
    setStatus(
      failed === 0
        ? `${enabled ? "Enabled" : "Disabled"} auto-update-branch for all ${succeeded} repos.`
        : `${enabled ? "Enabled" : "Disabled"} auto-update-branch for ${succeeded} of ${targets.length} repos — ${failed} failed, see status above.`,
      failed === 0 ? "" : "error",
    );
  }

  onMount(() => {
    fetch("/api/dashboard", { headers: { Accept: "application/json" } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          throw new Error("session expired");
        }
        if (!res.ok) throw new Error(`backend answered ${res.status}`);
        return res.json();
      })
      .then((data) => {
        repos = data.repos || [];
        forges = data.forges || [];
        loaded = true;
      })
      .catch(() => {
        // A transient failure here just leaves the empty state showing
        // — there's no dashboard-page-style error banner on this page.
        loaded = true;
      });
  });
</script>

<svelte:head>
  <title>Webhooks — Forge Board</title>
  <style>
    .webhooks-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .webhooks-header {
      margin-bottom: 22px;
    }
    .webhooks-header h1 {
      font-size: 19px;
      margin: 0;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 14px 18px 16px;
      margin-bottom: 18px;
    }
    .card .hint {
      font-size: 12.5px;
      color: var(--ink-3);
      margin: 0 0 14px;
    }
    .empty-state {
      font-size: 12.5px;
      color: var(--ink-3);
      margin: 0;
    }
    .status {
      font-size: 12.5px;
      min-height: 1.4em;
      margin: 0 0 12px;
    }
    .status.error {
      color: var(--critical);
    }
    /* .row-action (internal/api/static/style.css) is the dashboard's own
       real-button style for a consequential per-row write — reused here
       rather than this page's usual text-link buttons, since a bulk
       write across every repo missing a webhook deserves the same
       visual weight, not the quieter treatment a single "Ignore" gets. */
    .bulk-webhook-button {
      margin-bottom: 14px;
    }
    .bulk-webhook-button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th,
    .data-table td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    .data-table th {
      color: var(--ink-2);
      font-weight: 500;
    }
    .data-table td.status-confirmed {
      color: var(--good);
    }
    .data-table td.status-pending {
      color: var(--ink-3);
    }
    .data-table td.action button {
      font-size: 12.5px;
      color: var(--accent);
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      text-decoration: underline;
    }
    .data-table td.action button:disabled,
    .data-table td.action button[aria-disabled="true"] {
      color: var(--ink-3);
      cursor: default;
      text-decoration: none;
    }
    .ignore-scope-select {
      font-size: 12.5px;
      color: var(--accent);
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
    }
    .ignore-scope-select:disabled {
      color: var(--ink-3);
      cursor: default;
    }
    .webhook-locked {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-width: 220px;
    }
    .webhook-locked-reason {
      font-size: 11px;
      color: var(--ink-3);
      white-space: normal;
    }
    .webhook-locked-reason a {
      color: inherit;
    }
    .status-detail {
      font-size: 11px;
      color: var(--ink-3);
      margin-top: 2px;
    }
    .status-detail summary {
      cursor: pointer;
      color: var(--ink-2);
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
    }
    .sort-button:hover,
    .sort-button:focus-visible {
      color: var(--ink);
    }
    .sort-arrow {
      font-size: 9px;
    }
    .webhooks-filter-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .ignored-disclosure {
      margin-top: 18px;
      font-size: 12.5px;
      color: var(--ink-2);
    }
    .ignored-disclosure summary {
      cursor: pointer;
      color: var(--ink-2);
      font-weight: 500;
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
    }
    .ignored-scope {
      font-size: 11px;
      color: var(--ink-3);
    }
    .ignored-disclosure button {
      font-size: 12.5px;
      color: var(--accent);
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      text-decoration: underline;
      margin-left: auto;
    }
    .ignored-disclosure button:disabled {
      color: var(--ink-3);
      cursor: default;
      text-decoration: none;
    }

    /* Below ~600px, .data-table's 5 columns don't fit — an owner/repo
       full name has no natural wrap point, and the "Needs admin
       access…" sentence adds real width on top of it, together
       forcing the table wider than the viewport. Collapsed into a
       stacked card per row instead of scrolling horizontally: the
       established pattern for a table whose rows don't need
       side-by-side comparison against each other (CSS-Tricks,
       "Accessible, Simple, Responsive Tables"). The role="table"/
       "rowgroup"/"row"/"columnheader"/"cell" attributes on the markup
       exist for exactly this rule — restoring the ARIA table
       semantics browsers drop once display moves off table/table-row/
       table-cell, since an explicit role (unlike the implicit one)
       isn't tied to computed display. */
    @media (max-width: 600px) {
      .data-table,
      .data-table thead,
      .data-table tbody,
      .data-table tr,
      .data-table th,
      .data-table td {
        display: block;
      }
      .data-table thead tr {
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
      .data-table tbody tr {
        border-bottom: 1px solid var(--border);
        padding: 8px 0;
      }
      .data-table td {
        border-bottom: none;
        padding: 3px 0;
      }
      /* Only the value-only cells (Forge/Repo/Webhook) get a label —
         the two action cells already read fine on their own: a
         button's own text ("Add a webhook", "Ignore") or the "Needs
         admin access…" sentence doesn't need a heading repeating what
         it already says, the same restraint their desktop <th> already
         takes (both are header-less there too). */
      .data-table td[data-label]::before {
        content: attr(data-label);
        display: block;
        font-size: 11px;
        color: var(--ink-3);
      }
      .webhook-locked {
        max-width: 100%;
      }
    }
  </style>
</svelte:head>

<div class="webhooks-wrap">
  <div class="webhooks-header">
    <h1>Webhooks</h1>
  </div>

  <div class="card">
    <p class="hint" id="webhooks-hint">
      Every tracked repo, and whether this dashboard has confirmed a webhook for
      it. <a href="/settings.html#webhooks">Webhook setup</a>
    </p>

    {#if loaded && reposNeedingWebhook.length > 0}
      <button
        type="button"
        class="row-action bulk-webhook-button"
        disabled={bulkRunning}
        onclick={addAllWebhooks}
      >
        {bulkRunning
          ? "Setting up webhooks…"
          : `Set up webhooks for ${reposNeedingWebhook.length} repo${reposNeedingWebhook.length === 1 ? "" : "s"}`}
      </button>
    {/if}

    {#if loaded && reposMissingAutoUpdate.length > 0}
      <button
        type="button"
        class="row-action bulk-webhook-button"
        disabled={bulkAutoUpdateDirection !== null}
        onclick={() => bulkSetAutoUpdateBranch(true)}
      >
        {bulkAutoUpdateDirection === "enable"
          ? "Enabling auto-update…"
          : `Enable auto-update for ${reposMissingAutoUpdate.length} repo${reposMissingAutoUpdate.length === 1 ? "" : "s"}`}
      </button>
    {/if}

    {#if loaded && reposWithAutoUpdate.length > 0}
      <button
        type="button"
        class="row-action bulk-webhook-button"
        disabled={bulkAutoUpdateDirection !== null}
        onclick={() => bulkSetAutoUpdateBranch(false)}
      >
        {bulkAutoUpdateDirection === "disable"
          ? "Disabling auto-update…"
          : `Disable auto-update for ${reposWithAutoUpdate.length} repo${reposWithAutoUpdate.length === 1 ? "" : "s"}`}
      </button>
    {/if}

    {#if loaded && repos.length === 0}
      <p class="empty-state" id="webhooks-empty">
        Nothing tracked yet — save GitHub or Forgejo credentials in Settings
        first.
      </p>
    {:else if loaded}
      <p
        class="status"
        class:error={statusKind === "error"}
        id="webhooks-status"
        role="status"
        aria-live="polite"
      >
        {statusMessage}
        {#if statusDetail}
          <details class="status-detail">
            <summary>Show details</summary>
            {statusDetail}
          </details>
        {/if}
      </p>

      <div
        class="webhooks-filter-bar"
        id="webhooks-filter-bar"
        role="search"
        aria-label="Filter webhooks"
      >
        <fieldset class="forge-segmented">
          <legend class="sr-only">Filter by forge</legend>
          <label>
            <input
              type="radio"
              name="webhooks-forge"
              class="webhooks-filter"
              data-filter="forge"
              value=""
              checked={filterForge === ""}
              onchange={() => {
                filterForge = "";
                onFilterChange();
              }}
            />
            <span>All</span>
          </label>
          <label>
            <input
              type="radio"
              name="webhooks-forge"
              class="webhooks-filter"
              data-filter="forge"
              value="github"
              checked={filterForge === "github"}
              onchange={() => {
                filterForge = "github";
                onFilterChange();
              }}
            />
            <span>GitHub</span>
          </label>
          <label>
            <input
              type="radio"
              name="webhooks-forge"
              class="webhooks-filter"
              data-filter="forge"
              value="forgejo"
              checked={filterForge === "forgejo"}
              onchange={() => {
                filterForge = "forgejo";
                onFilterChange();
              }}
            />
            <span>Forgejo</span>
          </label>
        </fieldset>
        <input
          class="col-filter webhooks-filter"
          data-filter="repo"
          type="text"
          id="webhooks-repo-filter"
          placeholder="Repo"
          aria-label="Filter by repo name"
          autocomplete="off"
          bind:value={filterRepo}
          oninput={onFilterChange}
        />
        <select
          class="col-filter webhooks-filter"
          data-filter="status"
          id="webhooks-status-filter"
          aria-label="Filter by webhook status"
          bind:value={filterStatus}
          onchange={onFilterChange}
        >
          <option value="">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Not yet</option>
        </select>
      </div>

      {#if sortedRepos.length === 0}
        <p class="empty-state" id="webhooks-no-results">
          No repos match these filters.
        </p>
      {:else}
        <!-- svelte-ignore a11y_no_redundant_roles -- not redundant once
             the phone-width media query below sets display: block on
             every table element: that drops the implicit table/
             rowgroup/row roles the browser would otherwise infer from
             display, but an explicit role attribute isn't tied to
             computed display and survives -->
        <table class="data-table" id="webhooks-table" role="table">
          <caption class="sr-only">Every tracked repo's webhook status</caption>
          <!-- svelte-ignore a11y_no_redundant_roles -->
          <thead role="rowgroup">
            <!-- svelte-ignore a11y_no_redundant_roles -->
            <tr role="row">
              <th
                scope="col"
                role="columnheader"
                aria-sort={sortKey === "forge"
                  ? sortDir === "desc"
                    ? "descending"
                    : "ascending"
                  : "none"}
              >
                <button
                  type="button"
                  class="sort-button"
                  data-sort-key="forge"
                  onclick={() => setSort("forge")}
                  >Forge<span class="sort-arrow"
                    >{sortKey === "forge"
                      ? sortDir === "desc"
                        ? "▼"
                        : "▲"
                      : ""}</span
                  ></button
                >
              </th>
              <th
                scope="col"
                role="columnheader"
                aria-sort={sortKey === "fullName"
                  ? sortDir === "desc"
                    ? "descending"
                    : "ascending"
                  : "none"}
              >
                <button
                  type="button"
                  class="sort-button"
                  data-sort-key="fullName"
                  onclick={() => setSort("fullName")}
                  >Repo<span class="sort-arrow"
                    >{sortKey === "fullName"
                      ? sortDir === "desc"
                        ? "▼"
                        : "▲"
                      : ""}</span
                  ></button
                >
              </th>
              <th
                scope="col"
                role="columnheader"
                aria-sort={sortKey === "hasWebhook"
                  ? sortDir === "desc"
                    ? "descending"
                    : "ascending"
                  : "none"}
              >
                <button
                  type="button"
                  class="sort-button"
                  data-sort-key="hasWebhook"
                  onclick={() => setSort("hasWebhook")}
                  >Webhook<span class="sort-arrow"
                    >{sortKey === "hasWebhook"
                      ? sortDir === "desc"
                        ? "▼"
                        : "▲"
                      : ""}</span
                  ></button
                >
              </th>
              <th scope="col" role="columnheader"></th>
              <th scope="col" role="columnheader"></th>
              <th scope="col" role="columnheader"></th>
            </tr>
          </thead>
          <!-- svelte-ignore a11y_no_redundant_roles -->
          <tbody id="webhooks-rows" role="rowgroup">
            {#each pageItems as repo (rowKey(repo))}
              <!-- svelte-ignore a11y_no_redundant_roles -->
              <tr role="row">
                <td role="cell" data-label="Forge">
                  <span class="repo">
                    <span
                      class={`forge-badge ${FORGE_CLASSES[repo.forge] ?? ""}`}
                    >
                      <span class="dot"></span>
                      {FORGE_LABELS[repo.forge] ?? repo.forge}
                    </span>
                  </span>
                </td>
                <td role="cell" data-label="Repo">
                  {#if repo.url}
                    <a
                      class="repo-link"
                      href={repo.url}
                      target="_blank"
                      rel="noopener noreferrer">{repo.fullName}</a
                    >
                  {:else}
                    {repo.fullName}
                  {/if}
                </td>
                <td
                  role="cell"
                  data-label="Webhook"
                  class={repo.hasWebhook
                    ? "status-confirmed"
                    : "status-pending"}
                >
                  {repo.hasWebhook ? "Confirmed" : "Not yet"}
                </td>
                <td class="action" role="cell">
                  {#if !repo.hasWebhook}
                    {#if !repo.canManageWebhooks}
                      <span class="webhook-locked">
                        <span class="webhook-locked-reason">
                          Needs admin access on this repo — ask an owner, or <a
                            href="/settings.html#webhooks">set it up manually</a
                          >.
                        </span>
                      </span>
                    {:else if lockReasonFor(repo)}
                      <span class="webhook-locked">
                        <button
                          type="button"
                          aria-disabled="true"
                          aria-describedby={`webhook-locked-reason-${rowKey(repo)}`}
                          >Add a webhook</button
                        >
                        <span
                          class="webhook-locked-reason"
                          id={`webhook-locked-reason-${rowKey(repo)}`}
                          >{lockReasonFor(repo)}</span
                        >
                      </span>
                    {:else}
                      <button
                        type="button"
                        disabled={rowState[rowKey(repo)]?.adding}
                        onclick={() => addWebhook(repo)}
                        >{rowState[rowKey(repo)]?.adding
                          ? "Adding…"
                          : "Add a webhook"}</button
                      >
                    {/if}
                  {/if}
                </td>
                <td class="action" role="cell">
                  <button
                    type="button"
                    disabled={autoUpdateBusy[rowKey(repo)]}
                    onclick={() =>
                      setAutoUpdateBranch(repo, !repo.autoUpdateBranch)}
                    >{autoUpdateBusy[rowKey(repo)]
                      ? repo.autoUpdateBranch
                        ? "Disabling…"
                        : "Enabling…"
                      : repo.autoUpdateBranch
                        ? "Disable auto-update"
                        : "Enable auto-update"}</button
                  >
                </td>
                <td class="action" role="cell">
                  <select
                    class="ignore-scope-select"
                    aria-label={`Ignore ${repo.fullName}`}
                    disabled={ignoreBusy[rowKey(repo)]}
                    value=""
                    onchange={(e) => {
                      const scope = e.currentTarget.value as IgnoreScope;
                      e.currentTarget.value = "";
                      if (scope) ignoreRepo(repo, scope);
                    }}
                  >
                    <option value="" disabled selected>
                      {ignoreBusy[rowKey(repo)] ? "Ignoring…" : "Ignore…"}
                    </option>
                    {#each Object.entries(IGNORE_SCOPE_LABELS) as [scope, label] (scope)}
                      <option value={scope}>{label}</option>
                    {/each}
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if totalPages > 1}
          <div class="pagination" id="webhooks-pagination">
            <div class="pagination-pages" id="webhooks-pagination-pages">
              <button
                type="button"
                class="pagination-nav"
                disabled={clampedPage <= 1}
                onclick={() => (page = clampedPage - 1)}>Previous</button
              >
              {#each pageNumbers as n (n)}
                <button
                  type="button"
                  class="pagination-page"
                  class:active={n === clampedPage}
                  aria-current={n === clampedPage ? "page" : undefined}
                  onclick={() => (page = n)}>{n}</button
                >
              {/each}
              <button
                type="button"
                class="pagination-nav"
                disabled={clampedPage >= totalPages}
                onclick={() => (page = clampedPage + 1)}>Next</button
              >
            </div>
            <label class="pagination-size">
              Per page
              <select
                id="webhooks-page-size"
                aria-label="Results per page"
                bind:value={pageSize}
                onchange={() => (page = 1)}
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
        <details class="ignored-disclosure" id="webhooks-ignored">
          <summary>Ignored ({ignoredRepos.length})</summary>
          <ul>
            {#each ignoredRepos as repo (rowKey(repo))}
              <li>
                <span class={`forge-badge ${FORGE_CLASSES[repo.forge] ?? ""}`}>
                  <span class="dot"></span>
                  {FORGE_LABELS[repo.forge] ?? repo.forge}
                </span>
                {#if repo.url}
                  <a
                    class="repo-link"
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer">{repo.fullName}</a
                  >
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
                  disabled={ignoreBusy[rowKey(repo)]}
                  onclick={() => unignoreRepo(repo)}
                  >{ignoreBusy[rowKey(repo)]
                    ? "Un-ignoring…"
                    : "Un-ignore"}</button
                >
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
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
