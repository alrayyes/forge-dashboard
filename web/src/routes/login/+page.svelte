<script lang="ts">
  import { onMount } from "svelte";
  import {
    assertionCredentialToJSON,
    creationCredentialToJSON,
    prepareCreationOptions,
    prepareRequestOptions,
  } from "#lib/webauthn.js";
  import Footer from "#lib/Footer.svelte";
  import { ApiError, loginFailure } from "#lib/login-flow.js";

  let mode = $state<"login" | "register">("login");

  // Self-registration is only ever open on a fresh instance (zero
  // registered users). registration-status tells this page that, so the
  // "Register a new passkey instead" button only shows once the server has
  // confirmed it, not by default.
  let registrationOpen = $state(false);

  // Outside the (app) route group — no session yet, so none of its
  // shared header/nav chrome applies — but the shared Footer component
  // (version string included) is still rendered on this page too, same
  // as before footer.js's own injection was retired.
  onMount(() => {
    fetch("/api/auth/registration-status", {
      headers: { Accept: "application/json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { open: boolean } | null) => {
        if (data) registrationOpen = data.open;
      })
      .catch(() => {
        // Fails closed: registrationOpen stays false, so the button that
        // would let a visitor attempt self-registration just doesn't
        // show rather than offering something that can't be confirmed
        // to actually be open.
      });
  });

  // A cancelled prompt and a missing passkey look alike to the browser, so the
  // second one in a row is taken as the missing passkey.
  let notAllowedBefore = false;

  let loginSubmitting = $state(false);
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
      throw new ApiError(
        data.error || `request failed (${res.status})`,
        res.status,
      );
    return data;
  }

  async function submitLogin(e: SubmitEvent) {
    e.preventDefault();

    loginSubmitting = true;
    status = "Waiting for your passkey…";
    statusKind = "";

    try {
      const options = await postJSON("/api/auth/login/begin", {});
      const publicKey = prepareRequestOptions(options);
      const assertion = (await navigator.credentials.get({
        publicKey,
      })) as PublicKeyCredential;
      const credentialJSON = assertionCredentialToJSON(assertion);

      const res = await fetch("/api/auth/login/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(credentialJSON),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "sign-in failed");
      }

      status = "Signed in.";
      statusKind = "ok";
      window.location.href = "/";
    } catch (err) {
      const notAllowed = err instanceof Error && err.name === "NotAllowedError";
      const failure = loginFailure(
        err,
        registrationOpen,
        notAllowed && notAllowedBefore,
      );
      notAllowedBefore = notAllowed;
      if (failure.action === "register") {
        mode = "register";
        status = failure.message;
        statusKind = "";
      } else {
        status = failure.message;
        statusKind = "error";
      }
    } finally {
      loginSubmitting = false;
    }
  }

  async function submitRegister(e: SubmitEvent) {
    e.preventDefault();

    registerSubmitting = true;
    status = "Follow your browser or device prompt to create a passkey…";
    statusKind = "";

    try {
      const options = await postJSON("/api/auth/register/begin", {});
      const publicKey = prepareCreationOptions(options);
      const credential = (await navigator.credentials.create({
        publicKey,
      })) as PublicKeyCredential;
      const credentialJSON = creationCredentialToJSON(credential);

      const res = await fetch("/api/auth/register/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(credentialJSON),
      });
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
  <meta
    name="description"
    content="Sign in to Forge Board with a passkey, or register the first one on a new instance."
  />
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
        <div class="auth-actions">
          <button
            type="submit"
            class="btn btn-primary"
            id="login-submit"
            disabled={!passkeysSupported || loginSubmitting}
            >Sign in with a passkey</button
          >
          {#if registrationOpen}
            <button
              type="button"
              class="btn btn-secondary"
              id="show-register"
              disabled={!passkeysSupported}
              onclick={showRegister}>Register a new passkey instead</button
            >
          {/if}
        </div>
      </form>
    {:else}
      <form id="register-form" onsubmit={submitRegister}>
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

  <Footer />
</div>
