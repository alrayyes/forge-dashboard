<script lang="ts">
  // The root layout every route inherits, including the pre-auth login
  // page — deliberately just a passthrough. The shared header/nav chrome
  // (fetched data, the forge-status bar, the theme sync) belongs to
  // signed-in pages only, and lives in (app)/+layout.svelte instead so a
  // route outside that group — currently only /login — renders on its
  // own, with no nav a not-yet-authenticated visitor can't use anyway.
  let { children } = $props();
</script>

{@render children()}
