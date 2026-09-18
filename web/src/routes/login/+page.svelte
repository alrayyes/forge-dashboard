<script lang="ts">
  import { onMount } from "svelte";
  import {
    assertionCredentialToJSON,
    creationCredentialToJSON,
    prepareCreationOptions,
    prepareRequestOptions,
  } from "$lib/webauthn";

  // Outside the (app) route group — no session yet, so none of its
  // shared header/nav chrome applies — but footer.js (the version
  // string) is still shared with every other page, same as before.
  onMount(() => {
    const script = document.createElement("script");
    script.src = "/footer.js";
    document.body.appendChild(script);
  });

  let mode = $state<"login" | "register">("login");

  let loginUsername = $state("");
  let loginSubmitting = $state(false);

  let registerUsername = $state("");
  let registerDisplayName = $state("");
  let registerSubmitting = $state(false);

  let status = $state("");
  let statusKind = $state<"" | "error" | "ok">("");

  let passkeysSupported = $state(true);

  async function postJSON(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  async function submitLogin(e: SubmitEvent) {
    e.preventDefault();
    const username = loginUsername.trim();
    if (!username) return;

    loginSubmitting = true;
    status = "Waiting for your passkey…";
    statusKind = "";

    try {
      const options = await postJSON("/api/auth/login/begin", { username });
      const publicKey = prepareRequestOptions(options);
      const assertion = (await navigator.credentials.get({
        publicKey,
      })) as PublicKeyCredential;
      const credentialJSON = assertionCredentialToJSON(assertion);

      const res = await fetch(
        `/api/auth/login/finish?username=${encodeURIComponent(username)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(credentialJSON),
        },
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "sign-in failed");
      }

      status = "Signed in.";
      statusKind = "ok";
      window.location.href = "/";
    } catch (err) {
      status = (err as Error).message || "Sign-in failed.";
      statusKind = "error";
    } finally {
      loginSubmitting = false;
    }
  }

  async function submitRegister(e: SubmitEvent) {
    e.preventDefault();
    const username = registerUsername.trim();
    const displayName = registerDisplayName.trim();
    if (!username || !displayName) return;

    registerSubmitting = true;
    status = "Follow your browser or device prompt to create a passkey…";
    statusKind = "";

    try {
      const options = await postJSON("/api/auth/register/begin", {
        username,
        displayName,
      });
      const publicKey = prepareCreationOptions(options);
      const credential = (await navigator.credentials.create({
        publicKey,
      })) as PublicKeyCredential;
      const credentialJSON = creationCredentialToJSON(credential);

      const res = await fetch(
        `/api/auth/register/finish?username=${encodeURIComponent(username)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(credentialJSON),
        },
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "registration failed");
      }

      status = "Passkey created. Signed in.";
      statusKind = "ok";
      window.location.href = "/";
    } catch (err) {
      status = (err as Error).message || "Registration failed.";
      statusKind = "error";
    } finally {
      registerSubmitting = false;
    }
  }

  function showRegister() {
    mode = "register";
    status = "";
    statusKind = "";
  }

  function showLogin() {
    mode = "login";
    status = "";
    statusKind = "";
  }

  if (typeof window !== "undefined" && !window.PublicKeyCredential) {
    passkeysSupported = false;
    status = "This browser does not support passkeys.";
    statusKind = "error";
  }
</script>

<svelte:head>
  <title>Sign in — Forge Board</title>
  <style>
    .auth-wrap {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 24px;
    }
    .auth-wrap footer {
      width: 100%;
      max-width: 360px;
    }
    .auth-card {
      width: 100%;
      max-width: 360px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 28px 24px;
    }
    .auth-card .brand-mark {
      margin: 0 auto 16px;
    }
    .auth-card h1 {
      font-size: 18px;
      margin: 0 0 4px;
      text-align: center;
    }
    .auth-card p.sub {
      margin: 0 0 22px;
      text-align: center;
      font-size: 13px;
      color: var(--ink-3);
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
    .auth-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 18px;
    }
    .btn {
      font-family: inherit;
      font-size: 13.5px;
      font-weight: 500;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      text-align: center;
    }
    .btn-primary {
      background: var(--accent);
      color: var(--accent-ink);
    }
    .btn-primary:hover {
      filter: brightness(1.05);
    }
    .btn-secondary {
      background: var(--surface-sunken);
      color: var(--ink-2);
      border-color: var(--border-strong);
    }
    .btn-secondary:hover {
      color: var(--ink);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .status {
      margin-top: 14px;
      font-size: 12.5px;
      text-align: center;
      min-height: 1.4em;
    }
    .status.error {
      color: var(--critical);
    }
    .status.ok {
      color: var(--good);
    }
  </style>
</svelte:head>

<div class="auth-wrap">
  <div class="auth-card">
    <div class="brand-mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="6" cy="6" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
        <circle cx="6" cy="18" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
        <circle cx="18" cy="12" r="2.4" stroke="#eef1f6" stroke-width="1.6" />
        <path d="M6 8.4V15.6" stroke="#eef1f6" stroke-width="1.6" />
        <path d="M8.2 7.2 15.8 10.8" stroke="#eef1f6" stroke-width="1.6" />
        <path d="M8.2 16.8 15.8 13.2" stroke="#eef1f6" stroke-width="1.6" />
      </svg>
    </div>
    <h1>Forge Board</h1>
    <p class="sub">Sign in with a passkey — no password, ever.</p>

    {#if mode === "login"}
      <form id="login-form" onsubmit={submitLogin}>
        <div class="field">
          <label for="login-username">Username</label>
          <input
            id="login-username"
            name="username"
            autocomplete="username webauthn"
            required
            disabled={!passkeysSupported}
            bind:value={loginUsername}
          />
        </div>
        <div class="auth-actions">
          <button
            type="submit"
            class="btn btn-primary"
            id="login-submit"
            disabled={!passkeysSupported || loginSubmitting}
            >Sign in with a passkey</button
          >
          <button
            type="button"
            class="btn btn-secondary"
            id="show-register"
            disabled={!passkeysSupported}
            onclick={showRegister}>Register a new passkey instead</button
          >
        </div>
      </form>
    {:else}
      <form id="register-form" onsubmit={submitRegister}>
        <div class="field">
          <label for="register-username">Username</label>
          <input
            id="register-username"
            name="username"
            autocomplete="username"
            required
            bind:value={registerUsername}
          />
        </div>
        <div class="field">
          <label for="register-display-name">Display name</label>
          <input
            id="register-display-name"
            name="displayName"
            autocomplete="name"
            required
            bind:value={registerDisplayName}
          />
        </div>
        <div class="auth-actions">
          <button
            type="submit"
            class="btn btn-primary"
            id="register-submit"
            disabled={registerSubmitting}>Create passkey</button
          >
          <button
            type="button"
            class="btn btn-secondary"
            id="show-login"
            onclick={showLogin}>Back to sign in</button
          >
        </div>
      </form>
    {/if}

    <p
      class={`status${statusKind ? ` ${statusKind}` : ""}`}
      id="status"
      role="status"
      aria-live="polite"
    >
      {status}
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
