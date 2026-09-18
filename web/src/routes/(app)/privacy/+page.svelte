<script lang="ts">
  import { browser } from "$app/environment";

  // nav.js (injected by (app)/+layout.svelte) reads this to know not to
  // redirect a signed-out visitor to /login.html — the whole point of
  // this page staying reachable without a session. Set here, in the
  // component's own instance script rather than onMount, so it's on the
  // body before the layout's onMount injects and runs nav.js at all.
  if (browser) {
    document.body.dataset.pageRequiresAuth = "false";
  }
</script>

<svelte:head>
  <title>Privacy — Forge Board</title>
  <style>
    .legal-wrap {
      max-width: 720px;
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    .legal-header {
      margin-bottom: 22px;
    }
    .legal-header h1 {
      font-size: 19px;
      margin: 0;
    }
    .legal-body {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 18px 22px 20px;
      font-size: 13.5px;
      color: var(--ink-2);
      line-height: 1.6;
    }
    .legal-body h2 {
      font-size: 14px;
      color: var(--ink);
      margin: 18px 0 6px;
    }
    .legal-body h2:first-child {
      margin-top: 0;
    }
    .legal-body p {
      margin: 0 0 10px;
    }
    .legal-body ul {
      margin: 0 0 10px;
      padding-left: 20px;
    }
    .legal-body li {
      margin-bottom: 4px;
    }
    .legal-body a {
      color: var(--accent);
    }
  </style>
</svelte:head>

<div class="legal-wrap">
  <div class="legal-header">
    <h1>Privacy</h1>
  </div>

  <div class="legal-body">
    <p>
      This describes what forge-dashboard's own code stores or sends anywhere,
      not the policy of a company running it for you — this repository has no
      hosted instance of its own to describe. If you're using someone else's
      instance, ask them for their own answer to this page's questions.
    </p>

    <h2>Signing in</h2>
    <p>
      Accounts use passkeys (WebAuthn): no password is ever stored or
      transmitted, by this app or to it. A successful sign-in sets one session
      cookie, marked <span class="mono">HttpOnly</span>,
      <span class="mono">Secure</span>, and
      <span class="mono">SameSite=Lax</span> — it's read by this app's own backend
      only, never sent to a third party.
    </p>

    <h2>Forge credentials</h2>
    <p>
      A GitHub or Forgejo token you save in Settings is encrypted at rest and
      used only to call that forge's own API on your behalf — read-only, per the
      dashboard's own design. It's never sent anywhere except the forge it
      belongs to.
    </p>

    <h2>Webhook credentials</h2>
    <p>
      The webhook token (identifies you in a webhook URL) and secret (verifies a
      delivery's signature) are stored, but not encrypted at rest, since neither
      is a third-party credential the way a forge token is — see
      <a
        href="https://github.com/alrayyes/forge-dashboard/blob/main/docs/webhooks.md"
        target="_blank"
        rel="noopener noreferrer">docs/webhooks.md</a
      >
      for what they're for.
    </p>

    <h2>Third-party services</h2>
    <ul>
      <li>
        Every page here loads a stylesheet from
        <span class="mono">fonts.googleapis.com</span> (Google Fonts) — that request
        carries your IP address to Google, the same as it would for any site using
        their hosted fonts.
      </li>
      <li>No analytics, tracking, or telemetry of any kind.</li>
    </ul>

    <h2>What's not covered here</h2>
    <p>
      This page is about forge-dashboard's own code. It says nothing about
      GitHub's or Forgejo's own privacy practices for the data this app reads
      from them — that's between you and whichever forge you've connected.
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
