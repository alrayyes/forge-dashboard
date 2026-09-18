<script lang="ts">
  import { onMount } from "svelte";

  type RateLimit = { limit: number; remaining: number; resetsAt: string };
  type ForgeHealthEntry = { forge: string; rateLimit?: RateLimit };
  type Repo = {
    forge: string;
    fullName: string;
    url?: string;
    hasWebhook: boolean;
    canManageWebhooks?: boolean;
    ignored: boolean;
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
    if (f?.rateLimit && f.rateLimit.remaining === 0) {
      return `Rate limit exhausted · resets ${resetTimeLabel(f.rateLimit.resetsAt)}`;
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

  // Reversible, not destructive (#363's own design decision): no confirm
  // step, the same as addWebhook above — a pure local write, never
  // touching the forge, so there's nothing here a retry can't undo.
  async function setIgnored(repo: Repo, ignored: boolean) {
    const key = rowKey(repo);
    ignoreBusy[key] = true;
    const verb = ignored ? "Ignoring" : "Un-ignoring";
    setStatus(`${verb} ${repo.fullName}…`);

    try {
      const res = await fetch(`/api/repos/${ignored ? "ignore" : "unignore"}`, {
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
      repo.ignored = ignored;
      setStatus(
        ignored
          ? `${repo.fullName} is now ignored — its pull requests and issues won't show on the dashboard or Insights.`
          : `${repo.fullName} is no longer ignored.`,
      );
    } catch (err) {
      setStatus(
        `Couldn't ${ignored ? "ignore" : "un-ignore"} ${repo.fullName}: ${(err as Error).message}`,
        "error",
      );
    } finally {
      delete ignoreBusy[key];
    }
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
        <table class="data-table" id="webhooks-table">
          <caption class="sr-only">Every tracked repo's webhook status</caption>
          <thead>
            <tr>
              <th
                scope="col"
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
              <th scope="col"></th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="webhooks-rows">
            {#each pageItems as repo (rowKey(repo))}
              <tr>
                <td>
                  <span class="repo">
                    <span
                      class={`forge-badge ${FORGE_CLASSES[repo.forge] ?? ""}`}
                    >
                      <span class="dot"></span>
                      {FORGE_LABELS[repo.forge] ?? repo.forge}
                    </span>
                  </span>
                </td>
                <td>
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
                  class={repo.hasWebhook
                    ? "status-confirmed"
                    : "status-pending"}
                >
                  {repo.hasWebhook ? "Confirmed" : "Not yet"}
                </td>
                <td class="action">
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
                <td class="action">
                  <button
                    type="button"
                    disabled={ignoreBusy[rowKey(repo)]}
                    onclick={() => setIgnored(repo, true)}
                    >{ignoreBusy[rowKey(repo)] ? "Ignoring…" : "Ignore"}</button
                  >
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
                <button
                  type="button"
                  disabled={ignoreBusy[rowKey(repo)]}
                  onclick={() => setIgnored(repo, false)}
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
