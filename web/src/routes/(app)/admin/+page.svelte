<script lang="ts">
  import { onMount } from "svelte";

  type AdminUser = {
    username: string;
    displayName: string;
    createdAt: string;
    isAdmin: boolean;
  };

  type AdminInvite = {
    id: string;
    username: string;
    displayName: string;
    expiresAt: string;
  };

  type RequestLogRateLimit = {
    limit: number;
    remaining: number;
    resetsAt: string;
    cost?: number;
  };

  type RequestLogEntry = {
    loggedAt: string;
    forge: string;
    account?: string;
    method: string;
    endpoint: string;
    statusCode?: number;
    outcome: string;
    rateLimit?: RequestLogRateLimit;
  };

  let currentUsername = $state<string | null>(null);
  let users = $state<AdminUser[]>([]);
  let loaded = $state(false);
  let status = $state("");
  let statusKind = $state<"" | "error" | "ok">("");
  let pendingUsername = $state<string | null>(null);

  let invites = $state<AdminInvite[]>([]);
  let invitesLoaded = $state(false);
  let inviteUsername = $state("");
  let inviteDisplayName = $state("");
  let inviteSubmitting = $state(false);
  let inviteStatus = $state("");
  let inviteStatusKind = $state<"" | "error" | "ok">("");
  // The generated link is only ever shown once, right after creation —
  // same "show once" handling the invite's own raw token gets server-side
  // (#477) — reloading this page loses it, same as reloading Settings'
  // own API-token card loses a just-generated token.
  let generatedLink = $state<string | null>(null);
  let pendingInviteID = $state<string | null>(null);

  let requests = $state<RequestLogEntry[]>([]);
  let requestsLoaded = $state(false);
  let requestsStatus = $state("");
  let requestsStatusKind = $state<"" | "error" | "ok">("");
  let requestForgeFilter = $state("");
  let requestAccountFilter = $state("");
  // Populated from the first unfiltered load only (see loadRequests) —
  // every username the log has ever seen stays selectable even after the
  // admin narrows the table to one forge or account, rather than the
  // dropdown's own options shrinking along with the filtered result set.
  let requestAccountOptions = $state<string[]>([]);

  function escapeHTML(s: string): string {
    return s;
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  }

  function formatDateTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // outcomeBadgeClass buckets every ForgeErrorKind besides "rate_limited"
  // under one "other" style — a fourth or fifth failure color would cost
  // more legibility than the extra distinction is worth on a page whose
  // job is just "did this fail, and was it the rate limit."
  function outcomeBadgeClass(outcome: string): string {
    if (outcome === "success") return "outcome-success";
    if (outcome === "rate_limited") return "outcome-rate_limited";
    return "outcome-other";
  }

  function loadUsers(): Promise<void> {
    return fetch("/api/admin/users", {
      headers: { Accept: "application/json" },
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        if (res.status === 403) {
          window.location.href = "/";
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`could not load users (${res.status})`));
      })
      .then((data: AdminUser[] | null) => {
        if (!data) return;
        users = data;
        loaded = true;
      });
  }

  async function runAction(action: "revoke" | "remove", username: string) {
    const confirmed =
      action === "remove"
        ? window.confirm(
            `Remove ${username} outright? This deletes their account, passkeys and saved forge credentials — irreversible.`,
          )
        : window.confirm(
            `Revoke ${username}’s passkeys and sessions? They’ll be signed out everywhere and have to register again.`,
          );
    if (!confirmed) return;

    pendingUsername = username;
    status = action === "remove" ? "Removing…" : "Revoking…";
    statusKind = "";

    const request =
      action === "remove"
        ? fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
            method: "DELETE",
          })
        : fetch(`/api/admin/users/${encodeURIComponent(username)}/revoke`, {
            method: "POST",
          });

    try {
      const res = await request;
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "action failed");
      }
      status =
        action === "remove" ? `${username} removed.` : `${username} revoked.`;
      statusKind = "ok";
      await loadUsers();
    } catch (err) {
      status = (err as Error).message || "Action failed.";
      statusKind = "error";
    } finally {
      pendingUsername = null;
    }
  }

  function loadInvites(): Promise<void> {
    return fetch("/api/admin/invites", {
      headers: { Accept: "application/json" },
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        if (res.status === 403) {
          window.location.href = "/";
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`could not load invites (${res.status})`));
      })
      .then((data: AdminInvite[] | null) => {
        if (!data) return;
        invites = data;
        invitesLoaded = true;
      });
  }

  async function submitCreateInvite(e: SubmitEvent) {
    e.preventDefault();
    const username = inviteUsername.trim();
    const displayName = inviteDisplayName.trim();
    if (!username || !displayName) return;

    inviteSubmitting = true;
    inviteStatus = "Generating…";
    inviteStatusKind = "";
    generatedLink = null;

    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName }),
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "could not generate invite");
      }
      const created: { token: string } = await res.json();
      generatedLink = `${window.location.origin}/login.html?invite=${encodeURIComponent(created.token)}&username=${encodeURIComponent(username)}`;
      inviteStatus = `Invite generated for ${username}.`;
      inviteStatusKind = "ok";
      inviteUsername = "";
      inviteDisplayName = "";
      await loadInvites();
    } catch (err) {
      inviteStatus = (err as Error).message || "Could not generate invite.";
      inviteStatusKind = "error";
    } finally {
      inviteSubmitting = false;
    }
  }

  async function copyInviteLink() {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      inviteStatus = "Invite link copied.";
      inviteStatusKind = "ok";
    } catch {
      inviteStatus = "Could not copy — copy the link above manually.";
      inviteStatusKind = "error";
    }
  }

  async function revokeInvite(id: string) {
    const confirmed = window.confirm(
      "Revoke this invite? The link will stop working.",
    );
    if (!confirmed) return;

    pendingInviteID = id;
    inviteStatus = "Revoking…";
    inviteStatusKind = "";

    try {
      const res = await fetch(
        `/api/admin/invites/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
      );
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "could not revoke invite");
      }
      inviteStatus = "Invite revoked.";
      inviteStatusKind = "ok";
      await loadInvites();
    } catch (err) {
      inviteStatus = (err as Error).message || "Could not revoke invite.";
      inviteStatusKind = "error";
    } finally {
      pendingInviteID = null;
    }
  }

  // requestFilterParams is shared between loadRequests' own fetch and the
  // Export CSV link's href, so the two never drift out of sync — a filter
  // the table applies but the export forgets would make Export CSV lie
  // about which rows it's downloading.
  function requestFilterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (requestForgeFilter) params.set("forge", requestForgeFilter);
    if (requestAccountFilter) params.set("account", requestAccountFilter);
    return params;
  }

  function requestExportHref(): string {
    const qs = requestFilterParams().toString();
    return `/api/admin/requests/export${qs ? `?${qs}` : ""}`;
  }

  function loadRequests(): Promise<void> {
    const qs = requestFilterParams().toString();
    return fetch(`/api/admin/requests${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "application/json" },
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        if (res.status === 403) {
          window.location.href = "/";
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(
              new Error(`could not load requests (${res.status})`),
            );
      })
      .then((data: RequestLogEntry[] | null) => {
        if (!data) return;
        requests = data;
        requestsLoaded = true;
        if (!requestForgeFilter && !requestAccountFilter) {
          const seen = new Set<string>();
          for (const e of data) {
            if (e.account) seen.add(e.account);
          }
          requestAccountOptions = [...seen].sort();
        }
      })
      .catch((err) => {
        requestsStatus = err.message || "Could not load requests.";
        requestsStatusKind = "error";
      });
  }

  onMount(() => {
    fetch("/api/auth/session", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((session: { username: string } | null) => {
        if (session) currentUsername = session.username;
        return Promise.all([loadUsers(), loadInvites(), loadRequests()]);
      })
      .catch((err) => {
        status = err.message || "Could not load users.";
        statusKind = "error";
      });
  });
</script>

<svelte:head>
  <title>Admin — Forge Board</title>
  <style>
    .admin-wrap {
      max-width: 760px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .admin-header {
      margin-bottom: 22px;
    }
    .admin-header h1 {
      font-size: 19px;
      margin: 0;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 22px;
      margin-bottom: 18px;
      overflow-x: auto;
    }
    .card h2 {
      font-size: 15px;
      margin: 0 0 14px;
    }
    .field {
      margin-bottom: 14px;
    }
    .field label {
      display: block;
      font-size: 12px;
      color: var(--ink-2);
      margin-bottom: 5px;
    }
    .field input {
      width: 100%;
      font-family: inherit;
      font-size: 14px;
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
    }
    .field input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .generated-link {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .generated-link label {
      display: block;
      font-size: 12px;
      color: var(--ink-2);
      margin-bottom: 5px;
    }
    .generated-link-row {
      display: flex;
      gap: 8px;
    }
    .generated-link-row input {
      flex: 1;
      min-width: 0;
      font-family: inherit;
      font-size: 13px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13.5px;
    }
    th,
    td {
      text-align: left;
      padding: 10px 12px;
      white-space: nowrap;
    }
    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ink-2);
      border-bottom: 1px solid var(--border);
    }
    td {
      border-bottom: 1px solid var(--border);
    }
    tr:last-child td {
      border-bottom: none;
    }
    .admin-badge {
      font-size: 11px;
      font-weight: 500;
      color: var(--accent-ink);
      background: var(--accent);
      border-radius: 999px;
      padding: 1px 8px;
    }
    .row-actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 500;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
      cursor: pointer;
    }
    .btn:hover {
      filter: brightness(1.05);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    /* Neither --critical on --surface-sunken (4.29:1) nor on --critical-bg
       (3.94:1) clears the 4.5:1 WCAG AA text-contrast floor — axe-core
       caught both, live. Danger is a red border and bolder weight instead;
       the text itself stays --ink, the same color every other button's
       text already passes contrast with on this exact background. */
    .btn-danger {
      border-color: var(--critical);
      font-weight: 600;
    }
    .status {
      font-size: 12.5px;
      min-height: 1.4em;
      margin: 0 0 12px;
    }
    .status.error {
      color: var(--critical);
    }
    .status.ok {
      color: var(--good);
    }
    .empty-state {
      font-size: 13px;
      color: var(--ink-3);
      padding: 8px 0;
    }
    .request-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 14px;
      margin-bottom: 14px;
    }
    .request-filters .field {
      margin-bottom: 0;
      min-width: 160px;
    }
    .request-filters select {
      width: 100%;
      font-family: inherit;
      font-size: 14px;
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
    }
    .request-filters select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .request-filters .btn {
      text-decoration: none;
      display: inline-block;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12.5px;
    }
    /* Same accessible pairs style.css already established for .status.ok/
       .status.error and Settings' own "Configured" badge — darkened until
       each text/background pair clears WCAG AA on its own, not just
       against --surface (see style.css's own comments on --good/
       --critical/--warning). */
    .outcome-badge {
      font-size: 11px;
      font-weight: 500;
      border-radius: 999px;
      padding: 1px 8px;
      white-space: nowrap;
    }
    .outcome-badge.outcome-success {
      color: var(--good);
      background: var(--good-bg);
    }
    .outcome-badge.outcome-rate_limited {
      color: var(--warning);
      background: var(--warning-bg);
    }
    .outcome-badge.outcome-other {
      color: var(--critical);
      background: var(--critical-bg);
    }

    /* Below this width the table no longer fits without scrolling
       sideways, which real device testing found people don't discover on
       their own — a stacked card per user replaces it instead. The
       <thead>/<th> markup stays in the DOM (visually hidden, not
       display:none) so a screen reader still gets real table semantics;
       each <td> labels itself via data-label. */
    @media (max-width: 640px) {
      .card {
        overflow-x: visible;
        padding: 8px;
      }
      table,
      tbody,
      tr,
      td {
        display: block;
      }
      thead {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
        padding: 0;
        margin: -1px;
      }
      tbody tr {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 4px 14px;
        margin-bottom: 10px;
      }
      tbody tr:last-child {
        margin-bottom: 0;
      }
      td {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 0;
        border-bottom: 1px solid var(--border);
        white-space: normal;
      }
      td:last-child {
        border-bottom: none;
      }
      td::before {
        content: attr(data-label);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--ink-2);
        flex: none;
      }
      td.row-actions {
        justify-content: flex-end;
      }
      td.row-actions::before {
        content: none;
      }
    }
  </style>
</svelte:head>

<div class="admin-wrap">
  <div class="admin-header">
    <h1>Admin</h1>
  </div>

  <p
    class={`status${statusKind ? ` ${statusKind}` : ""}`}
    id="status"
    role="status"
    aria-live="polite"
  >
    {status}
  </p>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th scope="col">Username</th>
          <th scope="col">Display name</th>
          <th scope="col">Registered</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody id="user-rows">
        {#each users as u (u.username)}
          {@const isSelf = u.username === currentUsername}
          <tr data-username={u.username}>
            <td data-label="Username"
              >{escapeHTML(u.username)}{#if u.isAdmin}
                <span class="admin-badge">Admin</span>{/if}</td
            >
            <td data-label="Display name">{escapeHTML(u.displayName)}</td>
            <td data-label="Registered">{formatDate(u.createdAt)}</td>
            <td class="row-actions" data-label="Actions">
              <button
                class="btn"
                type="button"
                data-action="revoke"
                data-username={u.username}
                disabled={isSelf || pendingUsername === u.username}
                onclick={() => runAction("revoke", u.username)}>Revoke</button
              >
              <button
                class="btn btn-danger"
                type="button"
                data-action="remove"
                data-username={u.username}
                disabled={isSelf || pendingUsername === u.username}
                onclick={() => runAction("remove", u.username)}>Remove</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p
      class="empty-state"
      id="empty-state"
      hidden={!loaded ||
        users.filter((u) => u.username !== currentUsername).length > 0}
    >
      No other users are registered.
    </p>
  </div>

  <div class="card">
    <h2>Invites</h2>
    <form id="invite-form" onsubmit={submitCreateInvite}>
      <div class="field">
        <label for="invite-username">Username</label>
        <input
          id="invite-username"
          name="username"
          autocomplete="off"
          required
          bind:value={inviteUsername}
        />
      </div>
      <div class="field">
        <label for="invite-display-name">Display name</label>
        <input
          id="invite-display-name"
          name="displayName"
          autocomplete="off"
          required
          bind:value={inviteDisplayName}
        />
      </div>
      <button
        class="btn"
        type="submit"
        id="invite-submit"
        disabled={inviteSubmitting}>Generate invite</button
      >
    </form>

    <p
      class={`status${inviteStatusKind ? ` ${inviteStatusKind}` : ""}`}
      id="invite-status"
      role="status"
      aria-live="polite"
    >
      {inviteStatus}
    </p>

    {#if generatedLink}
      <div class="generated-link" id="generated-invite-link">
        <label for="generated-link-value">Invite link (shown once)</label>
        <div class="generated-link-row">
          <input
            id="generated-link-value"
            type="text"
            readonly
            value={generatedLink}
          />
          <button
            class="btn"
            type="button"
            id="copy-invite-link"
            onclick={copyInviteLink}>Copy</button
          >
        </div>
      </div>
    {/if}
  </div>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th scope="col">Username</th>
          <th scope="col">Expires</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody id="invite-rows">
        {#each invites as inv (inv.id)}
          <tr data-username={inv.username}>
            <td data-label="Username">{escapeHTML(inv.username)}</td>
            <td data-label="Expires">{formatDate(inv.expiresAt)}</td>
            <td class="row-actions" data-label="Actions">
              <button
                class="btn btn-danger"
                type="button"
                data-action="revoke-invite"
                data-username={inv.username}
                disabled={pendingInviteID === inv.id}
                onclick={() => revokeInvite(inv.id)}>Revoke</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p
      class="empty-state"
      id="invites-empty-state"
      hidden={!invitesLoaded || invites.length > 0}
    >
      No outstanding invites.
    </p>
  </div>

  <div class="card">
    <h2>Outbound requests</h2>
    <div class="request-filters">
      <div class="field">
        <label for="request-filter-forge">Forge</label>
        <select
          id="request-filter-forge"
          bind:value={requestForgeFilter}
          onchange={() => loadRequests()}
        >
          <option value="">All forges</option>
          <option value="github">GitHub</option>
          <option value="forgejo">Forgejo</option>
        </select>
      </div>
      <div class="field">
        <label for="request-filter-account">Account</label>
        <select
          id="request-filter-account"
          bind:value={requestAccountFilter}
          onchange={() => loadRequests()}
        >
          <option value="">All accounts</option>
          {#each requestAccountOptions as username (username)}
            <option value={username}>{username}</option>
          {/each}
        </select>
      </div>
      <a
        class="btn"
        id="export-requests-link"
        href={requestExportHref()}
        rel="external">Export CSV</a
      >
    </div>

    <p
      class={`status${requestsStatusKind ? ` ${requestsStatusKind}` : ""}`}
      id="requests-status"
      role="status"
      aria-live="polite"
    >
      {requestsStatus}
    </p>

    <table>
      <thead>
        <tr>
          <th scope="col">Logged at</th>
          <th scope="col">Forge</th>
          <th scope="col">Account</th>
          <th scope="col">Method</th>
          <th scope="col">Endpoint</th>
          <th scope="col">Status</th>
          <th scope="col">Outcome</th>
          <th scope="col">Rate limit</th>
        </tr>
      </thead>
      <tbody id="request-rows">
        {#each requests as r, i (`${r.loggedAt}-${r.forge}-${r.endpoint}-${i}`)}
          <tr>
            <td data-label="Logged at">{formatDateTime(r.loggedAt)}</td>
            <td data-label="Forge">{r.forge}</td>
            <td data-label="Account"
              >{r.account ? escapeHTML(r.account) : "—"}</td
            >
            <td data-label="Method">{r.method}</td>
            <td data-label="Endpoint" class="mono">{r.endpoint}</td>
            <td data-label="Status">{r.statusCode ?? "—"}</td>
            <td data-label="Outcome"
              ><span class={`outcome-badge ${outcomeBadgeClass(r.outcome)}`}
                >{r.outcome}</span
              ></td
            >
            <td data-label="Rate limit"
              >{#if r.rateLimit}{r.rateLimit.remaining} / {r.rateLimit
                  .limit}{:else}—{/if}</td
            >
          </tr>
        {/each}
      </tbody>
    </table>
    <p
      class="empty-state"
      id="requests-empty-state"
      hidden={!requestsLoaded || requests.length > 0}
    >
      No outbound requests match this filter.
    </p>
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
