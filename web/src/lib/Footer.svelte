<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";

  // Ports internal/api/static/footer.js's DOM-query IIFE to real Svelte
  // state (alrayyes/forge-dashboard#646) — same three outcomes: the
  // version fetch hasn't resolved yet (show nothing), the server is a
  // "dev" build (a plain label, no link), or a real released version (a
  // v-prefixed link to the changelog page, plain text on that page itself,
  // #786). The mirror/Disclaimer/Privacy markup below follows footer.js's
  // own behavior exactly (see that file for the byte-for-byte reference
  // this was ported from).
  type VersionState =
    | { kind: "unresolved" }
    | { kind: "dev" }
    | { kind: "released"; version: string };

  let versionState = $state<VersionState>({ kind: "unresolved" });

  // Matches (app)/+layout.svelte's own isCurrentRoute: tolerant of both
  // the bare SvelteKit route and today's real ".html" hard-navigation
  // target, since this component is reached via hard navigation on every
  // page it's rendered from right now.
  const currentPath = $derived(page.url.pathname);

  function isCurrentRoute(route: string): boolean {
    return (
      currentPath === route ||
      (route !== "/" && currentPath === `${route}.html`)
    );
  }

  onMount(() => {
    fetch("/api/version", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.version) return;
        versionState =
          data.version === "dev"
            ? { kind: "dev" }
            : { kind: "released", version: data.version };
      })
      .catch(() => {
        /* a transient failure here isn't worth showing anything for */
      });
  });
</script>

<footer>
  Read-only mirror of both forges &middot; credentials never leave <span
    class="mono">forge-dashboard</span
  >'s backend &middot;
  <a
    href="https://github.com/alrayyes/forge-dashboard"
    target="_blank"
    rel="noopener noreferrer">Source</a
  >
  <span id="footer-version"
    >{#if versionState.kind === "dev"}&#183; dev build{:else if versionState.kind === "released"}&#183;
      {#if isCurrentRoute("/releases")}<span class="mono"
          >v{versionState.version}</span
        >{:else}<a class="mono" href="/releases.html">v{versionState.version}</a
        >{/if}{/if}</span
  >{#if !isCurrentRoute("/disclaimer")}
    &#183; <a href="/disclaimer.html">Disclaimer</a
    >{/if}{#if !isCurrentRoute("/privacy")}
    &#183; <a href="/privacy.html">Privacy</a>{/if}
</footer>
