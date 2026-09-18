<script lang="ts">
  import { onMount } from "svelte";
  import { applyTheme, setThemeCookie, type ThemePreference } from "$lib/theme";

  type SharedUser = { username: string; displayName: string };
  type SharingResponse = {
    sharedWith: SharedUser[];
    sharedWithMe: SharedUser[];
  };
  type SettingsResponse = {
    githubUsername: string;
    githubTokenSet: boolean;
    forgejoUrl: string;
    forgejoUsername: string;
    forgejoTokenSet: boolean;
    webhookToken: string;
    webhookSecret: string;
    allowBotPrUpdates: boolean;
    renovateRebaseLabel: string;
    theme: ThemePreference;
  };
  type ApiToken = {
    id: string;
    label: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string;
  };

  function escapeHTML(s: string): string {
    return s;
  }

  // ---- sharing ----
  let sharedWith = $state<SharedUser[]>([]);
  let sharedWithMe = $state<SharedUser[]>([]);
  let shareUsername = $state("");
  let shareStatus = $state("");
  let shareStatusKind = $state<"" | "error" | "ok">("");

  function loadSharing(): Promise<void> {
    return fetch("/api/sharing", { headers: { Accept: "application/json" } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`could not load sharing (${res.status})`));
      })
      .then((data: SharingResponse | null) => {
        if (!data) return;
        sharedWith = data.sharedWith || [];
        sharedWithMe = data.sharedWithMe || [];
      });
  }

  async function submitShare(e: SubmitEvent) {
    e.preventDefault();
    const username = shareUsername.trim();
    if (!username) return;

    shareStatus = "Sharing…";
    shareStatusKind = "";
    try {
      const res = await fetch(`/api/sharing/${encodeURIComponent(username)}`, {
        method: "PUT",
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "could not share");
      }
      shareUsername = "";
      shareStatus = `Shared with ${username}.`;
      shareStatusKind = "ok";
      await loadSharing();
    } catch (err) {
      shareStatus = (err as Error).message || "Could not share.";
      shareStatusKind = "error";
    }
  }

  async function stopSharing(username: string) {
    shareStatus = "Removing…";
    shareStatusKind = "";
    try {
      const res = await fetch(`/api/sharing/${encodeURIComponent(username)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) throw new Error("could not stop sharing");
      shareStatus = `No longer shared with ${username}.`;
      shareStatusKind = "ok";
      await loadSharing();
    } catch (err) {
      shareStatus = (err as Error).message || "Could not stop sharing.";
      shareStatusKind = "error";
    }
  }

  // ---- credentials/settings form ----
  let githubToken = $state("");
  let githubTokenShown = $state(false);
  let githubUsername = $state("");
  let githubTokenSet = $state(false);

  let forgejoUrl = $state("");
  let forgejoUrlInput: HTMLInputElement | undefined = $state();
  let forgejoToken = $state("");
  let forgejoTokenShown = $state(false);
  let forgejoUsername = $state("");
  let forgejoTokenSet = $state(false);

  let allowBotPrUpdates = $state(false);
  let renovateRebaseLabel = $state("");

  let saving = $state(false);
  let status = $state("");
  let statusKind = $state<"" | "error" | "ok">("");

  // ---- theme (#352) ----
  let theme = $state<ThemePreference>("");
  let themeStatus = $state("");
  let themeStatusKind = $state<"" | "error">("");

  // Applies immediately (live preview, no header toggle anywhere to see
  // it take effect otherwise) and saves instantly through its own
  // dedicated endpoint — "set once and forget" (the ticket's own
  // research), not something that waits on the big form's Save button.
  function selectTheme(next: ThemePreference) {
    const previous = theme;
    theme = next;
    applyTheme(next);
    setThemeCookie(next);
    themeStatus = "";
    themeStatusKind = "";

    fetch("/api/settings/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ theme: next }),
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        if (!res.ok) throw new Error("could not save theme");
        return res.json();
      })
      .catch(() => {
        // Roll back the local/live change too — a failed save shouldn't
        // leave the control showing a choice that didn't actually stick.
        theme = previous;
        applyTheme(previous);
        setThemeCookie(previous);
        themeStatus = "Could not save theme.";
        themeStatusKind = "error";
      });
  }

  // Mirrors settings.js's updateForgejoTokenLink — no window access, so
  // safe as a plain $derived that also runs during adapter-static's
  // prerender pass (it just yields "" there, same as an empty field).
  const forgejoTokenLink = $derived.by(() => {
    const raw = forgejoUrl.trim();
    if (!raw) return "";
    let base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    base = base.replace(/\/+$/, "");
    return `${base}/user/settings/applications`;
  });

  function handleSave(e: SubmitEvent) {
    e.preventDefault();

    const trimmedForgejoUrl = forgejoUrl.trim();
    const trimmedForgejoUsername = forgejoUsername.trim();
    // A blank token field still means "keep the one already saved" (see
    // the PUT handler's doc comment), so a saved token counts here too —
    // otherwise re-saving without retyping the token would sail past
    // this check only to be rejected server-side.
    if (
      !trimmedForgejoUrl &&
      (forgejoToken || forgejoTokenSet || trimmedForgejoUsername)
    ) {
      status =
        "Forgejo needs an instance URL to use that token or username against.";
      statusKind = "error";
      forgejoUrlInput?.focus();
      return;
    }

    saving = true;
    status = "Saving…";
    statusKind = "";

    const body = {
      githubToken,
      githubUsername: githubUsername.trim(),
      forgejoUrl: trimmedForgejoUrl,
      forgejoToken,
      forgejoUsername: trimmedForgejoUsername,
      allowBotPrUpdates,
      renovateRebaseLabel: renovateRebaseLabel.trim(),
    };

    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        return res.json().then((data) => {
          if (!res.ok) throw new Error(data.error || "save failed");
          return data as SettingsResponse;
        });
      })
      .then((data) => {
        if (!data) return;
        githubTokenSet = data.githubTokenSet;
        forgejoTokenSet = data.forgejoTokenSet;
        // The token fields never get pre-filled with a real value, so
        // they're cleared after a successful save rather than left
        // showing whatever was just typed — the "Configured" badge is
        // what confirms it took.
        githubToken = "";
        forgejoToken = "";
        status = "Saved.";
        statusKind = "ok";
      })
      .catch((err) => {
        status = err.message || "Could not save settings.";
        statusKind = "error";
      })
      .finally(() => {
        saving = false;
      });
  }

  // ---- webhook URLs/secret ----
  let webhookUrlGithub = $state("");
  let webhookUrlForgejo = $state("");
  let webhookSecret = $state("");
  let webhookSecretShown = $state(false);
  let webhookCopyStatus = $state("");
  let webhookCopyStatusKind = $state<"" | "error" | "ok">("");

  let webhookCoverageVisible = $state(false);
  let webhookCoverageCount = $state("");

  function copyToClipboard(
    value: string,
    onResult: (message: string, kind: "ok" | "error") => void,
  ) {
    navigator.clipboard
      .writeText(value)
      .then(() => onResult("Copied.", "ok"))
      .catch(() =>
        onResult("Could not copy — select and copy the URL by hand.", "error"),
      );
  }

  function copyWebhookField(value: string) {
    copyToClipboard(value, (message, kind) => {
      webhookCopyStatus = message;
      webhookCopyStatusKind = kind;
    });
  }

  // ---- API tokens ----
  let apiTokens = $state<ApiToken[]>([]);
  let tokenLabel = $state("");
  let tokenRevealValue = $state("");
  let tokenRevealVisible = $state(false);
  let tokenStatus = $state("");
  let tokenStatusKind = $state<"" | "error" | "ok">("");

  // Mandatory, no "never expires" option (#356) — 30 days pre-selected,
  // matching GitHub's own fine-grained-PAT UI this account's users are
  // already used to. "custom" reveals a plain date input, capped by its
  // own min/max below rather than letting the picker offer a date the
  // backend would just reject.
  const TOKEN_EXPIRY_PRESET_DAYS = ["7", "30", "60", "90"] as const;
  let tokenExpiryPreset = $state<
    (typeof TOKEN_EXPIRY_PRESET_DAYS)[number] | "custom"
  >("30");
  let tokenExpiryCustomDate = $state("");

  function dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
  // Tomorrow, not today: expiresAt must be strictly in the future, and a
  // custom date resolves to the end of that day below — picking "today"
  // would round-trip to a moment already in the past by the time the
  // request reaches the server.
  const tokenExpiryMinDate = dateOnly(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  );
  const tokenExpiryMaxDate = dateOnly(
    new Date(Date.now() + 366 * 24 * 60 * 60 * 1000),
  );

  // null when a custom date is required but not chosen yet — the
  // caller's own signal to refuse submitting rather than sending an
  // empty/invalid expiresAt the backend would 400 on anyway.
  function computeTokenExpiresAt(): string | null {
    if (tokenExpiryPreset === "custom") {
      if (!tokenExpiryCustomDate) return null;
      return new Date(`${tokenExpiryCustomDate}T23:59:59`).toISOString();
    }
    const days = Number(tokenExpiryPreset);
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  function loadTokens(): Promise<void> {
    return fetch("/api/tokens", { headers: { Accept: "application/json" } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(
              new Error(`could not load api tokens (${res.status})`),
            );
      })
      .then((tokens: ApiToken[] | null) => {
        if (!tokens) return;
        apiTokens = tokens;
      });
  }

  async function submitGenerateToken(e: SubmitEvent) {
    e.preventDefault();
    const label = tokenLabel.trim();
    if (!label) return;
    const expiresAt = computeTokenExpiresAt();
    if (!expiresAt) {
      tokenStatus = "Pick a custom expiration date.";
      tokenStatusKind = "error";
      return;
    }

    tokenStatus = "Generating…";
    tokenStatusKind = "";
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ label, expiresAt }),
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "could not generate token");
      }
      const created = await res.json();
      tokenLabel = "";
      tokenRevealValue = created.token;
      tokenRevealVisible = true;
      tokenStatus = `Generated "${created.label}".`;
      tokenStatusKind = "ok";
      await loadTokens();
    } catch (err) {
      tokenStatus = (err as Error).message || "Could not generate token.";
      tokenStatusKind = "error";
    }
  }

  async function revokeToken(id: string) {
    tokenStatus = "Revoking…";
    tokenStatusKind = "";
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      if (!res.ok) throw new Error("could not revoke token");
      tokenStatus = "Revoked.";
      tokenStatusKind = "ok";
      await loadTokens();
    } catch (err) {
      tokenStatus = (err as Error).message || "Could not revoke token.";
      tokenStatusKind = "error";
    }
  }

  function copyTokenReveal(value: string) {
    copyToClipboard(value, (message, kind) => {
      tokenStatus = message;
      tokenStatusKind = kind;
    });
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  onMount(() => {
    loadSharing().catch((err) => {
      shareStatus = err.message || "Could not load sharing.";
      shareStatusKind = "error";
    });

    fetch("/api/settings", { headers: { Accept: "application/json" } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = "/login.html";
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(
              new Error(`could not load settings (${res.status})`),
            );
      })
      .then((data: SettingsResponse | null) => {
        if (!data) return;
        // Guarded, not a blind overwrite: onMount fires after hydration,
        // later relative to page load than a vanilla page's synchronous
        // bottom <script> — this fetch can resolve after a fast typist
        // has already started filling in a field. Only populate a field
        // still at its untouched "" default, so a real edit in flight
        // never gets silently clobbered by the initial load landing late.
        if (!githubUsername) githubUsername = data.githubUsername || "";
        if (!forgejoUrl) forgejoUrl = data.forgejoUrl || "";
        if (!forgejoUsername) forgejoUsername = data.forgejoUsername || "";
        githubTokenSet = data.githubTokenSet;
        forgejoTokenSet = data.forgejoTokenSet;
        webhookUrlGithub = `${window.location.origin}/api/webhooks/github/${data.webhookToken}`;
        webhookUrlForgejo = `${window.location.origin}/api/webhooks/forgejo/${data.webhookToken}`;
        webhookSecret = data.webhookSecret;
        allowBotPrUpdates = !!data.allowBotPrUpdates;
        if (!renovateRebaseLabel)
          renovateRebaseLabel = data.renovateRebaseLabel || "";
        // Just the control's own displayed value — (app)/+layout.svelte's
        // syncThemeFromServer already applies the theme itself and syncs
        // the cookie on every page, this one included.
        theme = data.theme || "";
      })
      .catch((err) => {
        status = err.message || "Could not load settings.";
        statusKind = "error";
      });

    // webhook coverage summary — see settings.js's own comment on
    // hasWebhook for why this is the summary-only view, and
    // /webhooks.html the per-repo detail.
    fetch("/api/dashboard", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const repos = data?.repos || [];
        if (!repos.length) {
          webhookCoverageVisible = false;
          return;
        }
        const withWebhook = repos.filter(
          (r: { hasWebhook: boolean }) => r.hasWebhook,
        ).length;
        webhookCoverageCount = `${withWebhook} of ${repos.length} confirmed`;
        webhookCoverageVisible = true;
      })
      .catch(() => {
        // A transient failure here just leaves the summary hidden —
        // this page's own settings form is where a real error banner
        // belongs.
      });

    loadTokens().catch((err) => {
      tokenStatus = err.message || "Could not load API tokens.";
      tokenStatusKind = "error";
    });
  });
</script>

<svelte:head>
  <title>Settings — Forge Board</title>
  <style>
    .settings-wrap {
      max-width: 640px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .settings-header {
      margin-bottom: 22px;
    }
    .settings-header h1 {
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
    .card .hint a {
      color: var(--accent);
    }
    /* Same segmented-control visual as index.html's forge filter
       (.forge-segmented in style.css) but self-contained rather than
       reused: that class's hidden-input positioning rule is
       deliberately scoped to .filter-bar .forge-segmented (see its own
       comment there on a real specificity bug that scoping fixed), so
       reusing it bare here would leave the radio itself visible instead
       of hidden behind the pill. */
    .theme-segmented {
      display: inline-flex;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      padding: 2px;
      margin: 0 0 8px;
      gap: 2px;
    }
    .theme-segmented label {
      position: relative;
      display: inline-flex;
    }
    .theme-segmented input {
      position: absolute;
      inset: 0;
      margin: 0;
      min-width: 0;
      opacity: 0;
    }
    .theme-segmented span {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      color: var(--ink-2);
      cursor: pointer;
    }
    .theme-segmented input:checked + span {
      background: var(--accent);
      color: var(--accent-ink);
    }
    .theme-segmented input:focus-visible + span {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .field {
      margin-bottom: 14px;
    }
    .field:last-child {
      margin-bottom: 0;
    }
    .field label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12.5px;
      color: var(--ink-2);
      margin-bottom: 5px;
    }
    .field label .configured {
      font-size: 11px;
      font-weight: 500;
      color: var(--good);
      background: var(--good-bg);
      border-radius: 999px;
      padding: 1px 8px;
    }
    .field input {
      width: 100%;
      font-family: inherit;
      font-size: 13.5px;
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
    .token-input {
      position: relative;
    }
    .token-input input {
      padding-right: 58px;
    }
    .token-input--dual input {
      padding-right: 112px;
    }
    .token-input-actions {
      position: absolute;
      right: 5px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      gap: 5px;
    }
    .token-input-actions .copy-button,
    .token-input-actions .token-toggle {
      position: static;
      transform: none;
    }
    .token-toggle {
      position: absolute;
      right: 5px;
      top: 50%;
      transform: translateY(-50%);
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--ink-2);
      cursor: pointer;
    }
    .token-toggle:hover {
      color: var(--ink);
    }
    .token-toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .field .field-hint {
      font-size: 11.5px;
      color: var(--ink-3);
      margin-top: 4px;
    }
    .field .field-hint code {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 11px;
      background: var(--surface-sunken);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 4px;
    }
    .field .field-hint a {
      display: inline-block;
      margin-top: 2px;
      color: var(--accent);
    }
    .field .field-hint a:not([href]) {
      color: var(--ink-3);
      pointer-events: none;
    }
    .field .field-hint p {
      margin: 0 0 6px;
    }
    .field .field-hint p:last-child {
      margin-bottom: 0;
    }
    .field .field-hint ul {
      margin: 2px 0 6px;
      padding-left: 18px;
    }
    .field .field-hint li {
      margin-bottom: 2px;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 4px;
    }
    .btn {
      font-family: inherit;
      font-size: 13.5px;
      font-weight: 500;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    .btn-primary {
      background: var(--accent);
      color: var(--accent-ink);
    }
    .btn-primary:hover {
      filter: brightness(1.05);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .status {
      font-size: 12.5px;
      min-height: 1.4em;
    }
    .status.error {
      color: var(--critical);
    }
    .status.ok {
      color: var(--good);
    }
    .share-form {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    .share-form input {
      flex: 1;
      min-width: 140px;
      font-family: inherit;
      font-size: 13.5px;
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
    }
    /* #token-form's own expiry preset -- not part of the label/date
       input's flex:1 group above, or it'd grow to match their width on
       a wide viewport for no reason; a fixed intrinsic width instead,
       same as any other <select> elsewhere in this file. */
    #token-form select {
      font-family: inherit;
      font-size: 13.5px;
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
    }
    .share-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .share-list li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13.5px;
    }
    .share-list li:last-child {
      border-bottom: none;
    }
    .share-list .btn-remove {
      font-family: inherit;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--surface-sunken);
      color: var(--ink);
      cursor: pointer;
    }
    .share-list .btn-remove:hover {
      filter: brightness(1.05);
    }
    .empty-state {
      font-size: 12.5px;
      color: var(--ink-3);
      margin: 0;
    }
    .copy-button,
    .token-copy-button {
      position: absolute;
      right: 5px;
      top: 50%;
      transform: translateY(-50%);
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--ink-2);
      cursor: pointer;
    }
    .copy-button:hover,
    .token-copy-button:hover {
      color: var(--ink);
    }
    .copy-button:focus-visible,
    .token-copy-button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .api-token-meta {
      font-size: 12px;
      color: var(--ink-3);
    }
  </style>
</svelte:head>

<div class="settings-wrap">
  <div class="settings-header">
    <h1>Settings</h1>
  </div>

  <div class="card">
    <h2>Appearance</h2>
    <fieldset class="theme-segmented">
      <legend class="sr-only">Theme</legend>
      <label>
        <input
          type="radio"
          name="theme"
          value=""
          checked={theme === ""}
          onchange={() => selectTheme("")}
        />
        <span>System</span>
      </label>
      <label>
        <input
          type="radio"
          name="theme"
          value="light"
          checked={theme === "light"}
          onchange={() => selectTheme("light")}
        />
        <span>Light</span>
      </label>
      <label>
        <input
          type="radio"
          name="theme"
          value="dark"
          checked={theme === "dark"}
          onchange={() => selectTheme("dark")}
        />
        <span>Dark</span>
      </label>
    </fieldset>
    <p
      class={`status${themeStatusKind ? ` ${themeStatusKind}` : ""}`}
      id="theme-status"
      role="status"
      aria-live="polite"
    >
      {themeStatus}
    </p>
  </div>

  <div class="card">
    <h2>Sharing</h2>
    <p class="hint">
      Let another registered user view your dashboard, read-only — they need no
      tokens of their own configured.
    </p>
    <form id="share-form" class="share-form" onsubmit={submitShare}>
      <label for="share-username" class="sr-only"
        >Username to share your dashboard with</label
      >
      <input
        id="share-username"
        type="text"
        autocomplete="off"
        placeholder="username"
        required
        bind:value={shareUsername}
      />
      <button type="submit" class="btn btn-primary">Share</button>
    </form>
    <ul class="share-list" id="shared-with-list">
      {#each sharedWith as u (u.username)}
        <li>
          <span>{escapeHTML(u.displayName)} ({escapeHTML(u.username)})</span>
          <button
            class="btn-remove"
            type="button"
            data-username={u.username}
            onclick={() => stopSharing(u.username)}>Stop sharing</button
          >
        </li>
      {/each}
    </ul>
    <p
      class="empty-state"
      id="shared-with-empty"
      hidden={sharedWith.length > 0}
    >
      You haven't shared your dashboard with anyone yet.
    </p>
    <p
      class={`status${shareStatusKind ? ` ${shareStatusKind}` : ""}`}
      id="share-status"
      role="status"
      aria-live="polite"
    >
      {shareStatus}
    </p>
  </div>

  <div class="card">
    <h2>Shared with you</h2>
    <p class="hint">Switch to one of these from the dashboard header.</p>
    <ul class="share-list" id="shared-with-me-list">
      {#each sharedWithMe as u (u.username)}
        <li>
          <span>{escapeHTML(u.displayName)} ({escapeHTML(u.username)})</span>
        </li>
      {/each}
    </ul>
    <p
      class="empty-state"
      id="shared-with-me-empty"
      hidden={sharedWithMe.length > 0}
    >
      Nobody has shared their dashboard with you yet.
    </p>
  </div>

  <form id="settings-form" onsubmit={handleSave}>
    <div class="card">
      <h2>GitHub</h2>
      <p class="hint">
        A token sees every repo it can push to, private included. Leave the
        token blank to keep the one already saved.
      </p>
      <div class="field">
        <label for="github-token"
          >Personal access token <span
            class="configured"
            id="github-token-badge"
            hidden={!githubTokenSet}>Configured</span
          ></label
        >
        <div class="token-input">
          <input
            id="github-token"
            name="githubToken"
            type={githubTokenShown ? "text" : "password"}
            autocomplete="off"
            placeholder="ghp_…"
            aria-describedby="github-token-hint"
            bind:value={githubToken}
          />
          <button
            type="button"
            class="token-toggle"
            data-target="github-token"
            aria-pressed={githubTokenShown}
            aria-label={githubTokenShown
              ? "Hide personal access token"
              : "Show personal access token"}
            onclick={() => (githubTokenShown = !githubTokenShown)}
            >{githubTokenShown ? "Hide" : "Show"}</button
          >
        </div>
        <div class="field-hint" id="github-token-hint">
          <p>
            Needs read-only access to your repos, their issues, pull requests,
            and commit status, plus read/write access to each repo's webhooks —
            to show whether one's already pointed at this dashboard, and to
            create or fix one up when you click "Add a webhook" (see the
            Webhooks page).
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&amp;description=forge-dashboard"
              target="_blank"
              rel="noopener noreferrer"
              >Create a token with that scope already set &rarr;</a
            >
          </p>
          <p>
            Classic token: the <code>repo</code> scope (or just
            <code>public_repo</code> if every repo you track is public) already covers
            this.
          </p>
          <p>Fine-grained token, grant all of:</p>
          <ul>
            <li>
              Metadata — Read-only (mandatory on every fine-grained token
              regardless)
            </li>
            <li>Issues — Read-only</li>
            <li>Pull requests — Read-only</li>
            <li>Commit statuses — Read-only</li>
            <li>Checks — Read-only</li>
            <li>Webhooks — Read and write</li>
          </ul>
          <p>
            And make sure the repo is actually in this token's own repository
            list (or that it's set to "All repositories"), separately from those
            permissions — a repo left out fails with "Resource not accessible by
            personal access token" even though every permission above is granted
            correctly. Easy to hit for a repo created after the token, or a
            token deliberately scoped to a subset of repos.
          </p>
        </div>
      </div>
      <div class="field">
        <label for="github-username"
          >Username (used only when no token is set)</label
        >
        <input
          id="github-username"
          name="githubUsername"
          type="text"
          autocomplete="off"
          placeholder="your-username"
          aria-describedby="github-username-hint"
          bind:value={githubUsername}
        />
        <p class="field-hint" id="github-username-hint">
          Shows that account's public repos, unauthenticated — no credential
          involved.
        </p>
      </div>
    </div>

    <div class="card">
      <h2>Forgejo</h2>
      <p class="hint">
        Same trade-off as GitHub: a token sees private repos, a username alone
        sees public ones only.
      </p>
      <div class="field">
        <label for="forgejo-url">Instance URL</label>
        <input
          id="forgejo-url"
          name="forgejoUrl"
          type="text"
          autocomplete="off"
          placeholder="https://git.example.com"
          aria-describedby="forgejo-url-hint"
          bind:value={forgejoUrl}
          bind:this={forgejoUrlInput}
        />
        <p class="field-hint" id="forgejo-url-hint">
          Required if you set a token or username below — otherwise Forgejo is
          skipped entirely, with nothing to tell it which instance to use.
        </p>
      </div>
      <div class="field">
        <label for="forgejo-token"
          >API token <span
            class="configured"
            id="forgejo-token-badge"
            hidden={!forgejoTokenSet}>Configured</span
          ></label
        >
        <div class="token-input">
          <input
            id="forgejo-token"
            name="forgejoToken"
            type={forgejoTokenShown ? "text" : "password"}
            autocomplete="off"
            placeholder="Leave blank to keep the saved token"
            aria-describedby="forgejo-token-hint"
            bind:value={forgejoToken}
          />
          <button
            type="button"
            class="token-toggle"
            data-target="forgejo-token"
            aria-pressed={forgejoTokenShown}
            aria-label={forgejoTokenShown ? "Hide API token" : "Show API token"}
            onclick={() => (forgejoTokenShown = !forgejoTokenShown)}
            >{forgejoTokenShown ? "Hide" : "Show"}</button
          >
        </div>
        <div class="field-hint" id="forgejo-token-hint">
          <p>
            Needs your repos and their issues/pull requests, plus each repo's
            webhooks — to show whether one's already pointed at this dashboard,
            and to create or fix one up when you click "Add a webhook" (see the
            Webhooks page).
            {#if forgejoTokenLink}
              <a
                id="forgejo-token-link"
                href={forgejoTokenLink}
                target="_blank"
                rel="noopener noreferrer"
                >Open your instance's token settings &rarr;</a
              >
            {:else}
              <a
                id="forgejo-token-link"
                target="_blank"
                rel="noopener noreferrer"
                >Open your instance's token settings &rarr;</a
              >
              <span id="forgejo-token-link-disabled-hint"
                >(fill in the instance URL above first)</span
              >
            {/if}
          </p>
          <p>Select all of:</p>
          <ul>
            <li>
              <code>write:repository</code> — Forgejo's webhook API has no
              separate read-only scope, so even just checking coverage needs
              write, not just <code>read:repository</code>
            </li>
            <li><code>read:issue</code></li>
            <li>
              <code>read:user</code> — easy to miss since it isn't obviously
              related to repos, but <code>GET /user/repos</code> (how repository discovery
              works) refuses a token without it
            </li>
          </ul>
        </div>
      </div>
      <div class="field">
        <label for="forgejo-username"
          >Username (used only when no token is set)</label
        >
        <input
          id="forgejo-username"
          name="forgejoUsername"
          type="text"
          autocomplete="off"
          placeholder="your-username"
          bind:value={forgejoUsername}
        />
      </div>
    </div>

    <div class="card">
      <h2>Pull request behavior</h2>
      <div class="field">
        <label class="checkbox-filter">
          <input
            type="checkbox"
            id="allow-bot-pr-updates"
            name="allowBotPrUpdates"
            aria-describedby="allow-bot-pr-updates-hint"
            bind:checked={allowBotPrUpdates}
          />
          Allow updating bot-managed PR branches
        </label>
        <p class="field-hint" id="allow-bot-pr-updates-hint">
          release-please, Dependabot, and Renovate already keep their own pull
          requests current on their own schedule — leaving this off hides
          "Update branch" on a PR any of them opened. Turn it on to treat those
          PRs the same as any other.
        </p>
      </div>
      <div
        class="field"
        id="renovate-rebase-label-field"
        hidden={!allowBotPrUpdates}
      >
        <label for="renovate-rebase-label">Renovate rebase label</label>
        <input
          id="renovate-rebase-label"
          name="renovateRebaseLabel"
          type="text"
          autocomplete="off"
          placeholder="rebase"
          aria-describedby="renovate-rebase-label-hint"
          bind:value={renovateRebaseLabel}
        />
        <p class="field-hint" id="renovate-rebase-label-hint">
          The label Renovate's own rebase/retry trigger listens for on your
          repos (Renovate's own <code>rebaseLabel</code> config option — genuinely
          per-repo configurable). Leave blank to use Renovate's own default, "rebase".
        </p>
      </div>
    </div>

    <div class="actions">
      <button
        type="submit"
        class="btn btn-primary"
        id="save-button"
        disabled={saving}>Save</button
      >
      <p
        class={`status${statusKind ? ` ${statusKind}` : ""}`}
        id="status"
        role="status"
        aria-live="polite"
      >
        {status}
      </p>
    </div>
  </form>

  <div class="card" id="webhooks">
    <h2>Webhooks</h2>
    <p class="hint">
      Add these to a repo to update your dashboard the moment something happens
      there, instead of waiting on the next poll. Optional — polling every 30
      seconds keeps running either way.
      <a
        href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/webhooks.md"
        target="_blank"
        rel="noopener noreferrer">Full setup steps &rarr;</a
      >
    </p>
    <div class="field">
      <label for="webhook-url-github">GitHub webhook URL</label>
      <div class="token-input">
        <input
          id="webhook-url-github"
          type="text"
          readonly
          aria-describedby="webhook-url-github-hint"
          value={webhookUrlGithub}
        />
        <button
          type="button"
          class="copy-button"
          data-copy-target="webhook-url-github"
          onclick={() => copyWebhookField(webhookUrlGithub)}>Copy</button
        >
      </div>
      <p class="field-hint" id="webhook-url-github-hint">
        Repo &rarr; Settings &rarr; Webhooks &rarr; Add webhook. Content type
        <code>application/json</code>, secret below, events: Pull requests,
        Issues, Statuses, Check runs.
      </p>
    </div>
    <div class="field">
      <label for="webhook-url-forgejo">Forgejo webhook URL</label>
      <div class="token-input">
        <input
          id="webhook-url-forgejo"
          type="text"
          readonly
          aria-describedby="webhook-url-forgejo-hint"
          value={webhookUrlForgejo}
        />
        <button
          type="button"
          class="copy-button"
          data-copy-target="webhook-url-forgejo"
          onclick={() => copyWebhookField(webhookUrlForgejo)}>Copy</button
        >
      </div>
      <p class="field-hint" id="webhook-url-forgejo-hint">
        Repo &rarr; Settings &rarr; Webhooks &rarr; Add Webhook &rarr; Forgejo.
        Secret below, trigger on: Pull Request, Issue, Push, Status.
      </p>
    </div>
    <div class="field">
      <label for="webhook-secret">Secret</label>
      <div class="token-input token-input--dual">
        <input
          id="webhook-secret"
          type={webhookSecretShown ? "text" : "password"}
          readonly
          value={webhookSecret}
        />
        <div class="token-input-actions">
          <button
            type="button"
            class="copy-button"
            data-copy-target="webhook-secret"
            onclick={() => copyWebhookField(webhookSecret)}>Copy</button
          >
          <button
            type="button"
            class="token-toggle"
            data-target="webhook-secret"
            aria-pressed={webhookSecretShown}
            aria-label={webhookSecretShown
              ? "Hide webhook secret"
              : "Show webhook secret"}
            onclick={() => (webhookSecretShown = !webhookSecretShown)}
            >{webhookSecretShown ? "Hide" : "Show"}</button
          >
        </div>
      </div>
      <p class="field-hint">
        The same secret goes in both webhooks above — it's what proves a
        delivery actually came from your forge.
      </p>
    </div>
    <p
      class={`status${webhookCopyStatusKind ? ` ${webhookCopyStatusKind}` : ""}`}
      id="webhook-copy-status"
      role="status"
      aria-live="polite"
    >
      {webhookCopyStatus}
    </p>
    <p
      class="hint"
      id="webhook-coverage-summary"
      hidden={!webhookCoverageVisible}
    >
      <span id="webhook-coverage-count">{webhookCoverageCount}</span>
      &middot;
      <a href="/webhooks.html">See which repos, and add a webhook &rarr;</a>
    </p>
  </div>

  <div class="card" id="api-tokens">
    <h2>API tokens</h2>
    <p class="hint">
      A Bearer credential a script can use instead of a browser's passkey
      session &mdash; <code>Authorization: Bearer &lt;token&gt;</code> against any
      endpoint this dashboard itself calls.
    </p>
    <form id="token-form" class="share-form" onsubmit={submitGenerateToken}>
      <label for="token-label" class="sr-only">Label for the new token</label>
      <input
        id="token-label"
        type="text"
        autocomplete="off"
        placeholder="label, e.g. laptop"
        required
        bind:value={tokenLabel}
      />
      <label for="token-expiry-preset" class="sr-only">Expiration</label>
      <select id="token-expiry-preset" bind:value={tokenExpiryPreset}>
        {#each TOKEN_EXPIRY_PRESET_DAYS as days (days)}
          <option value={days}>{days} days</option>
        {/each}
        <option value="custom">Custom date&hellip;</option>
      </select>
      {#if tokenExpiryPreset === "custom"}
        <label for="token-expiry-custom-date" class="sr-only"
          >Custom expiration date</label
        >
        <input
          id="token-expiry-custom-date"
          type="date"
          required
          min={tokenExpiryMinDate}
          max={tokenExpiryMaxDate}
          bind:value={tokenExpiryCustomDate}
        />
      {/if}
      <button type="submit" class="btn btn-primary">Generate</button>
    </form>
    <div class="field" id="token-reveal-field" hidden={!tokenRevealVisible}>
      <label for="token-reveal-value">New token &mdash; copy it now</label>
      <div class="token-input">
        <input
          id="token-reveal-value"
          type="text"
          readonly
          value={tokenRevealValue}
        />
        <button
          type="button"
          class="token-copy-button"
          data-copy-target="token-reveal-value"
          onclick={() => copyTokenReveal(tokenRevealValue)}>Copy</button
        >
      </div>
      <p class="field-hint">
        Shown once. It won't be shown again &mdash; losing it means generating a
        new one.
      </p>
    </div>
    <ul class="share-list" id="api-token-list">
      {#each apiTokens as tok (tok.id)}
        <li>
          <span>
            {escapeHTML(tok.label)}<br />
            <span class="api-token-meta"
              >Created {formatDate(tok.createdAt)} &middot; Expires {formatDate(
                tok.expiresAt,
              )} &middot; Last used {tok.lastUsedAt
                ? formatDate(tok.lastUsedAt)
                : "never used"}</span
            >
          </span>
          <button
            class="btn-remove"
            type="button"
            data-token-id={tok.id}
            onclick={() => revokeToken(tok.id)}>Revoke</button
          >
        </li>
      {/each}
    </ul>
    <p class="empty-state" id="api-token-empty" hidden={apiTokens.length > 0}>
      No API tokens yet.
    </p>
    <p
      class={`status${tokenStatusKind ? ` ${tokenStatusKind}` : ""}`}
      id="token-status"
      role="status"
      aria-live="polite"
    >
      {tokenStatus}
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
