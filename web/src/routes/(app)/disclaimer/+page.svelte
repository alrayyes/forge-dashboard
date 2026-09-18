<script lang="ts">
  import { browser } from "$app/environment";

  // See privacy/+page.svelte's identical comment.
  if (browser) {
    document.body.dataset.pageRequiresAuth = "false";
  }
</script>

<svelte:head>
  <title>Disclaimer — Forge Board</title>
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
    .legal-body a {
      color: var(--accent);
    }
  </style>
</svelte:head>

<div class="legal-wrap">
  <div class="legal-header">
    <h1>Disclaimer</h1>
  </div>

  <div class="legal-body">
    <h2>No warranty</h2>
    <p>
      forge-dashboard is free software, licensed under the
      <a
        href="https://github.com/alrayyes/forge-dashboard/blob/main/LICENSE"
        target="_blank"
        rel="noopener noreferrer">AGPL-3.0</a
      >. Like every GPL-family licence, it's provided as-is, with no warranty of
      any kind — no guarantee it's fit for a particular purpose, or that it's
      free of bugs. Read the licence for the exact terms; this page doesn't
      restate or reinterpret them.
    </p>

    <h2>What this is</h2>
    <p>
      A read-only dashboard over repositories you already have access to on
      GitHub and/or a Forgejo instance. It doesn't modify anything on either
      forge on your behalf, and running your own instance means you're the one
      responsible for the credentials you give it and the host you run it on.
    </p>

    <h2>Third-party services</h2>
    <p>
      Every page here loads a stylesheet from
      <span class="mono">fonts.googleapis.com</span>. That's the only
      third-party request this app's own pages make — see the
      <a href="/privacy.html">Privacy</a> page for what that means and what else does
      or doesn't leave this app's own backend.
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
