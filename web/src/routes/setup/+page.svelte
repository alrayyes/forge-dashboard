<script lang="ts">
  import { onMount, tick } from "svelte";
  import Footer from "#lib/Footer.svelte";
  import {
    continueState,
    forgejoAppsUrl,
    forgejoView,
    githubView,
    installRows,
    parseSetupQuery,
    readSetupFacts,
    setupErrorMessage,
    type SetupFacts,
  } from "#lib/setup.js";

  // Outside the (app) group: this is where a board with nothing linked lands,
  // so none of the dashboard chrome (nav, counts, polling) applies. The server
  // states facts; #lib/setup.ts decides what they mean.
  let facts = $state<SetupFacts | null>(null);
  let loadFailed = $state(false);
  let checking = $state(false);
  let failure = $state("");
  let installRequested = $state(false);

  let instanceUrl = $state("");
  let clientId = $state("");
  let forgejoProblem = $state("");
  let starting = $state<"" | "github" | "forgejo">("");
  let problemEl = $state<HTMLElement | undefined>();
  let copied = $state<"" | "yes" | "failed">("");
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  const appsUrl = $derived(forgejoAppsUrl(instanceUrl));

  const gh = $derived(facts ? githubView(facts) : null);
  const fj = $derived(facts ? forgejoView(facts) : null);
  const rows = $derived(
    facts ? installRows(facts.github, installRequested) : [],
  );
  const next = $derived(facts ? continueState(facts) : null);

  async function load() {
    checking = true;
    try {
      const res = await fetch("/api/v1/setup", {
        headers: { Accept: "application/json" },
      });
      if (res.status === 401) {
        window.location.href = "/login.html";
        return;
      }
      const read = res.ok ? readSetupFacts(await res.json()) : null;
      if (read) {
        facts = read;
        loadFailed = false;
        if (!instanceUrl) instanceUrl = read.forgejo.instanceUrl;
      } else {
        loadFailed = true;
      }
    } catch {
      loadFailed = true;
    } finally {
      checking = false;
    }
  }

  onMount(() => {
    const query = parseSetupQuery(window.location.search);
    if (query.error) failure = setupErrorMessage(query.error);
    installRequested = query.installRequested;
    load();
  });

  async function start(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function authorizeGitHub() {
    starting = "github";
    failure = "";
    try {
      const { ok, data } = await start("/api/v1/connections/github", {});
      if (ok && typeof data.authorizeUrl === "string") {
        window.location.href = data.authorizeUrl;
        return;
      }
      failure =
        "GitHub could not be reached from here. Nothing was saved. Try again.";
    } catch {
      failure =
        "GitHub could not be reached from here. Nothing was saved. Try again.";
    }
    starting = "";
  }

  async function copyRedirect(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = "yes";
    } catch {
      copied = "failed";
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = ""), 4000);
  }

  async function showForgejoProblem(message: string) {
    forgejoProblem = message;
    starting = "";
    await tick();
    problemEl?.focus();
  }

  async function authorizeForgejo(e: SubmitEvent) {
    e.preventDefault();
    starting = "forgejo";
    failure = "";
    forgejoProblem = "";
    try {
      const { ok, data } = await start("/api/v1/connections/forgejo", {
        instanceUrl: instanceUrl.trim(),
        clientId: clientId.trim(),
      });
      if (ok && typeof data.authorizeUrl === "string") {
        window.location.href = data.authorizeUrl;
        return;
      }
      await showForgejoProblem(
        typeof data.error === "string"
          ? data.error
          : "That did not work. Check the address and the Client ID.",
      );
    } catch {
      await showForgejoProblem(
        "That did not work. Check the address and the Client ID.",
      );
    }
  }

  function signOut() {
    fetch("/api/v1/auth/logout", { method: "POST" }).finally(() => {
      window.location.href = "/login.html";
    });
  }

  function repoLine(
    count: number,
    state: "counting" | "none" | "ready" | "blocked",
  ) {
    if (state === "ready") {
      return `${count} ${count === 1 ? "repository" : "repositories"} found`;
    }
    if (state === "counting") return "Counting repositories…";
    if (state === "none") return "No repositories yet";
    return "Repositories show up here once the steps above are done";
  }
</script>

<svelte:head>
  <title>Set up your board — Forge Board</title>
  <meta
    name="description"
    content="Connect GitHub or Forgejo so Forge Board has repositories to show."
  />
  <meta name="robots" content="noindex, nofollow" />
  <style>
    .setup-wrap {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 24px 16px;
    }
    .setup-main {
      width: 100%;
      max-width: 720px;
    }
    .setup-main h1 {
      font-size: 1.375rem;
      margin: 8px 0 4px;
    }
    .setup-main .lede {
      margin: 0 0 20px;
      color: var(--ink-2);
      font-size: 0.875rem;
    }
    .setup-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 20px;
      margin-bottom: 16px;
    }
    .setup-card h2 {
      font-size: 1.0625rem;
      margin: 0 0 12px;
    }
    .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .step {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 12px;
    }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--border-strong);
      color: var(--ink-2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .step[data-state="current"] .step-num {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }
    .step[data-state="done"] .step-num {
      border-color: var(--good);
      color: var(--good);
    }
    .step h3 {
      font-size: 0.9375rem;
      margin: 3px 0 4px;
    }
    .step p,
    .step li,
    .hint {
      margin: 0 0 8px;
      font-size: 0.8125rem;
      color: var(--ink-2);
    }
    .step ul {
      list-style: none;
      margin: 0 0 8px;
      padding: 0;
    }
    .install-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border-strong);
      color: var(--ink-2);
    }
    .badge.connected {
      border-color: var(--good);
      color: var(--good);
    }
    .setup-main code {
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 0.78125rem;
      overflow-wrap: anywhere;
      background: var(--surface-sunken);
      padding: 1px 5px;
      border-radius: 4px;
    }
    .copy-box {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--surface-sunken);
    }
    .copy-box code {
      background: none;
      padding: 0;
    }
    .btn-small {
      min-height: 28px;
      padding: 4px 10px;
      font-size: 0.78125rem;
    }
    .copied {
      margin-left: 8px;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--good);
    }
    .problem:focus {
      outline: 2px solid var(--critical);
      outline-offset: 2px;
    }
    .setup-main a {
      color: var(--accent);
    }
    .setup-main a.btn-primary {
      color: var(--accent-ink);
    }
    .setup-main a.btn-secondary {
      color: var(--ink);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 10px;
    }
    .field label {
      font-size: 0.8125rem;
      font-weight: 500;
    }
    .field input {
      font: inherit;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      font-size: 0.875rem;
      padding: 8px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--surface);
      color: var(--ink);
      min-height: 36px;
    }
    .btn {
      font-family: inherit;
      font-size: 0.84375rem;
      font-weight: 500;
      padding: 8px 14px;
      min-height: 36px;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .btn-primary {
      background: var(--accent);
      color: var(--accent-ink);
    }
    .btn-secondary {
      background: var(--surface-sunken);
      color: var(--ink);
      border-color: var(--border-strong);
    }
    .btn[aria-disabled="true"],
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .problem {
      color: var(--critical);
      font-size: 0.8125rem;
      margin: 0 0 10px;
    }
    .failure {
      background: var(--critical-bg);
      color: var(--critical);
      border: 1px solid var(--critical);
      border-radius: 8px;
      padding: 10px 12px;
      margin: 0 0 16px;
      font-size: 0.8125rem;
    }
    .setup-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }
    .setup-foot .hint {
      flex: 1 1 200px;
      margin: 0;
    }
    .setup-wrap footer {
      width: 100%;
      max-width: 720px;
    }
  </style>
</svelte:head>

<div class="setup-wrap">
  <main class="setup-main">
    <h1>Set up your board</h1>
    <p class="lede">
      Connect GitHub or Forgejo so the board has repositories to show. One is
      enough, and the other can wait.
    </p>

    {#if failure}
      <p class="failure" role="alert">{failure}</p>
    {/if}

    {#if loadFailed}
      <p class="problem" role="alert">
        The setup details could not be loaded.
        <button type="button" class="btn btn-secondary" onclick={load}>
          Try again
        </button>
      </p>
    {/if}

    {#if facts && gh && fj && next}
      <section class="setup-card" aria-labelledby="github-heading">
        <h2 id="github-heading">GitHub</h2>
        <ol class="steps">
          <li
            class="step"
            data-state={gh.steps[0]}
            aria-current={gh.steps[0] === "current" ? "step" : undefined}
          >
            <span class="step-num" aria-hidden="true">1</span>
            <div>
              <h3>Authorize with GitHub</h3>
              {#if gh.steps[0] === "done"}
                <p>Authorized.</p>
              {:else if facts.github.configured}
                <p>
                  Sign in on GitHub so the board can see your installations.
                </p>
                <button
                  type="button"
                  class="btn btn-primary"
                  aria-busy={starting === "github"}
                  disabled={starting === "github"}
                  onclick={authorizeGitHub}
                >
                  {starting === "github"
                    ? "Authorizing…"
                    : "Authorize with GitHub"}
                </button>
              {:else}
                <p>
                  This server has no GitHub App configured. Use Forgejo, or see
                  the configuration guide.
                </p>
              {/if}
            </div>
          </li>
          <li
            class="step"
            data-state={gh.steps[1]}
            aria-current={gh.steps[1] === "current" ? "step" : undefined}
          >
            <span class="step-num" aria-hidden="true">2</span>
            <div>
              <h3>Install the app</h3>
              {#if rows.length > 0}
                <ul>
                  {#each rows as row (row.key)}
                    <li class="install-row">
                      <strong>{row.account}</strong>
                      {#if row.state === "connected"}
                        <span class="badge connected">Connected</span>
                      {:else if row.state === "waiting"}
                        <span class="badge">Waiting for owner approval</span>
                        <button
                          type="button"
                          class="btn btn-secondary"
                          disabled={checking}
                          onclick={load}
                          aria-label={`Check again for ${row.account}`}
                        >
                          Check again
                        </button>
                      {:else}
                        <span class="badge">Not installed</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if facts.github.installationsUnavailable}
                <p>
                  Your installations could not be read from GitHub just now.
                </p>
              {/if}
              {#if gh.steps[1] !== "done" && gh.steps[0] === "done"}
                <div class="actions">
                  <a
                    class="btn btn-primary"
                    href={facts.github.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Install on GitHub (opens in a new tab)
                  </a>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    disabled={checking}
                    onclick={load}
                  >
                    Check again
                  </button>
                </div>
              {:else if gh.steps[1] !== "done"}
                <p>Do this after step 1.</p>
              {/if}
            </div>
          </li>
          <li
            class="step"
            data-state={gh.steps[2]}
            aria-current={gh.steps[2] === "current" ? "step" : undefined}
          >
            <span class="step-num" aria-hidden="true">3</span>
            <div>
              <h3>Repositories</h3>
              <p>{repoLine(facts.github.repositoryCount, gh.repos)}</p>
              {#if gh.repos === "none"}
                <p role="alert">
                  The app can see none of them yet. Give it access to some on
                  GitHub, then check again.
                </p>
                <div class="actions">
                  <a
                    class="btn btn-secondary"
                    href={facts.github.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Manage access on GitHub (opens in a new tab)
                  </a>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    disabled={checking}
                    onclick={load}
                  >
                    Check again
                  </button>
                </div>
              {/if}
            </div>
          </li>
        </ol>
      </section>

      <section class="setup-card" aria-labelledby="forgejo-heading">
        <h2 id="forgejo-heading">Forgejo</h2>
        <ol class="steps">
          <li
            class="step"
            data-state={fj.steps[0]}
            aria-current={fj.steps[0] === "current" ? "step" : undefined}
          >
            <span class="step-num" aria-hidden="true">1</span>
            <div>
              <h3>Register an OAuth app on your Forgejo</h3>
              {#if fj.steps[0] === "done"}
                <p>Registered.</p>
              {:else}
                <p>
                  In Forgejo, open Settings, Applications and create an OAuth2
                  application.
                </p>
                {#if appsUrl}
                  <p>
                    <a href={appsUrl} target="_blank" rel="noopener noreferrer">
                      Create the app on your Forgejo (opens in a new tab)
                    </a>
                  </p>
                {:else}
                  <p class="hint">
                    Enter your instance address below to get a link to its
                    applications page.
                  </p>
                {/if}
                <ul>
                  <li>
                    Redirect URI:
                    <span class="copy-box">
                      <code>{facts.forgejo.redirectUri}</code>
                      <button
                        type="button"
                        class="btn btn-secondary btn-small"
                        onclick={() =>
                          copyRedirect(facts?.forgejo.redirectUri ?? "")}
                      >
                        Copy redirect URI
                      </button>
                    </span>
                    <span class="copied" role="status">
                      {#if copied === "yes"}Copied{:else if copied === "failed"}Could
                        not copy. Select the address and copy it by hand.{/if}
                    </span>
                  </li>
                  <li>Leave Confidential client unticked.</li>
                  <li>
                    Permissions requested:
                    <code>{facts.forgejo.scopes.join(" ")}</code>
                  </li>
                  <li>
                    If Forgejo says the redirect does not match, the address
                    above has to be copied exactly, with no trailing slash added
                    or dropped.
                  </li>
                </ul>
              {/if}
            </div>
          </li>
          <li
            class="step"
            data-state={fj.steps[1]}
            aria-current={fj.steps[1] === "current" ? "step" : undefined}
          >
            <span class="step-num" aria-hidden="true">2</span>
            <div>
              <h3>Authorize with Forgejo</h3>
              {#if fj.steps[1] === "done"}
                <p>
                  Linked{facts.forgejo.account
                    ? ` as ${facts.forgejo.account}`
                    : ""}.
                </p>
              {:else}
                <form
                  onsubmit={authorizeForgejo}
                  aria-busy={starting === "forgejo"}
                >
                  <div class="field">
                    <label for="forgejo-url">Instance address</label>
                    <input
                      id="forgejo-url"
                      type="url"
                      inputmode="url"
                      autocomplete="url"
                      placeholder="https://git.example.com"
                      bind:value={instanceUrl}
                      required
                    />
                  </div>
                  <div class="field">
                    <label for="forgejo-client">Client ID</label>
                    <input
                      id="forgejo-client"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      bind:value={clientId}
                      required
                      aria-invalid={forgejoProblem ? "true" : undefined}
                      aria-describedby={forgejoProblem
                        ? "forgejo-problem"
                        : undefined}
                    />
                  </div>
                  {#if forgejoProblem}
                    <p
                      class="problem"
                      id="forgejo-problem"
                      role="alert"
                      tabindex="-1"
                      bind:this={problemEl}
                    >
                      {forgejoProblem}
                    </p>
                  {/if}
                  <button
                    type="submit"
                    class="btn btn-primary"
                    disabled={starting === "forgejo"}
                  >
                    {starting === "forgejo"
                      ? "Authorizing…"
                      : "Authorize with Forgejo"}
                  </button>
                </form>
              {/if}
            </div>
          </li>
          <li
            class="step"
            data-state={fj.steps[2]}
            aria-current={fj.steps[2] === "current" ? "step" : undefined}
          >
            <span class="step-num" aria-hidden="true">3</span>
            <div>
              <h3>Repositories</h3>
              <p>{repoLine(facts.forgejo.repositoryCount, fj.repos)}</p>
              {#if fj.repos === "none"}
                <button
                  type="button"
                  class="btn btn-secondary"
                  disabled={checking}
                  onclick={load}
                >
                  Check again
                </button>
              {/if}
            </div>
          </li>
        </ol>
      </section>

      <div class="setup-foot">
        {#if next.enabled}
          <a class="btn btn-primary" href="/">Continue</a>
        {:else}
          <button
            type="button"
            class="btn btn-primary"
            aria-disabled="true"
            aria-describedby="continue-hint"
          >
            Continue
          </button>
        {/if}
        <p class="hint" id="continue-hint">{next.hint}</p>
        <button type="button" class="btn btn-secondary" onclick={signOut}>
          Sign out
        </button>
      </div>
    {:else if loadFailed}
      <div class="setup-foot">
        <button type="button" class="btn btn-secondary" onclick={signOut}>
          Sign out
        </button>
      </div>
    {:else}
      <p class="hint" role="status">Loading…</p>
    {/if}
  </main>

  <Footer />
</div>
