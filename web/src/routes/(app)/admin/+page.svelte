<script lang="ts">
  import { onMount } from "svelte";

  type AdminUser = {
    username: string;
    displayName: string;
    createdAt: string;
    isAdmin: boolean;
  };

  let currentUsername = $state<string | null>(null);
  let users = $state<AdminUser[]>([]);
  let loaded = $state(false);
  let status = $state("");
  let statusKind = $state<"" | "error" | "ok">("");
  let pendingUsername = $state<string | null>(null);

  function escapeHTML(s: string): string {
    return s;
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
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

  onMount(() => {
    fetch("/api/auth/session", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((session: { username: string } | null) => {
        if (session) currentUsername = session.username;
        return loadUsers();
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
