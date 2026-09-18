<script lang="ts">
  import { onMount } from "svelte";
  import { syncThemeFromServer } from "$lib/theme";

  let { children } = $props();

  // footer.js/nav.js are plain DOM-query IIFEs, not ES modules — loaded
  // as real <script src> elements injected after mount rather than
  // written directly in the markup below, since Svelte only allows one
  // top-level <script> per component (svelte.dev/e/script_duplicate).
  onMount(() => {
    for (const src of ["/footer.js", "/nav.js"]) {
      const script = document.createElement("script");
      script.src = src;
      document.body.appendChild(script);
    }

    // The header no longer has its own toggle (#352 — theme is a
    // Settings-only control now); this is the "did another device
    // change it" half, reconciling the fast local cookie theme.js
    // already applied against whatever's actually saved.
    syncThemeFromServer();
  });
</script>

<!--
  The header/nav/footer chrome every page shares — ported from the vanilla
  pages' duplicated HTML (internal/api/static/*.html) rather than redesigned,
  so nav.js/footer.js keep working unmodified: both are plain DOM-query
  scripts with no framework coupling, matching the same ids/classes this
  markup still carries. A page migrating off this layout later can drop
  footer.js/nav.js in favor of real Svelte state — not done yet, since
  that's a bigger, separate change than this page's own migration.
-->
<div class="wrap">
  <header>
    <a class="brand" href="/" aria-label="Forge Board home">
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
      <div>
        <h1>Forge Board</h1>
      </div>
    </a>
    <div class="header-status">
      <span class="mono" id="whoami" style="font-size:12px;color:var(--ink-3);"
      ></span>
      <nav class="app-nav" aria-label="Main">
        <a
          class="theme-toggle"
          href="/"
          aria-label="Home"
          title="Home"
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path
              d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"
            /></svg
          >
        </a>
        <a
          class="theme-toggle"
          href="/insights.html"
          aria-label="Insights"
          title="Insights"
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M3 3v18h18" /><path
              d="M18.7 8 13 13.7l-3-3L4 16.7"
            /></svg
          >
        </a>
        <a
          class="theme-toggle"
          href="/webhooks.html"
          aria-label="Webhooks"
          title="Webhooks"
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg
          >
        </a>
        <a
          class="theme-toggle"
          href="/settings.html"
          aria-label="Settings"
          title="Settings"
          style="text-decoration:none;"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><circle cx="12" cy="12" r="3" /><path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            /></svg
          >
        </a>
        <a
          class="theme-toggle"
          href="/admin.html"
          id="admin-link"
          aria-label="Admin"
          title="Admin"
          style="text-decoration:none;"
          hidden
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle
              cx="9"
              cy="7"
              r="4"
            /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path
              d="M16 3.13a4 4 0 0 1 0 7.75"
            /></svg
          >
        </a>
      </nav>
      <button
        class="theme-toggle"
        id="logout-button"
        type="button"
        aria-label="Sign out"
        title="Sign out"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path
            d="M16 17l5-5-5-5"
          /><path d="M21 12H9" /></svg
        >
      </button>
    </div>
  </header>
</div>

{@render children()}
