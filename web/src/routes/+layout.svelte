<script lang="ts">
  // The app's own fonts (#797), bundled by Vite so they're served from this
  // origin. Latin and Latin Extended only: names and titles with accents
  // keep their glyphs, and font-display is swap. IBM Plex is licensed under
  // the SIL Open Font License 1.1; see the README.
  import "@fontsource/ibm-plex-sans/latin-400.css";
  import "@fontsource/ibm-plex-sans/latin-ext-400.css";
  import "@fontsource/ibm-plex-sans/latin-500.css";
  import "@fontsource/ibm-plex-sans/latin-ext-500.css";
  import "@fontsource/ibm-plex-sans/latin-600.css";
  import "@fontsource/ibm-plex-sans/latin-ext-600.css";
  import "@fontsource/ibm-plex-sans/latin-700.css";
  import "@fontsource/ibm-plex-sans/latin-ext-700.css";
  import "@fontsource/ibm-plex-mono/latin-400.css";
  import "@fontsource/ibm-plex-mono/latin-ext-400.css";
  import "@fontsource/ibm-plex-mono/latin-500.css";
  import "@fontsource/ibm-plex-mono/latin-ext-500.css";
  import "@fontsource/ibm-plex-mono/latin-600.css";
  import "@fontsource/ibm-plex-mono/latin-ext-600.css";

  // The root layout every route inherits, including the pre-auth login
  // page — deliberately just a passthrough. The shared header/nav chrome
  // (fetched data, the forge-status bar, the theme sync) belongs to
  // signed-in pages only, and lives in (app)/+layout.svelte instead so a
  // route outside that group — currently only /login — renders on its
  // own, with no nav a not-yet-authenticated visitor can't use anyway.
  let { children } = $props();
</script>

{@render children()}
