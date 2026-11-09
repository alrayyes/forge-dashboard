<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import Footer from "./Footer.svelte";

  // Footer reads the page's path from $app/state, the one thing Storybook
  // mocks here, and the version from /api/version.
  const { Story } = defineMeta({
    title: "Footer",
    component: Footer,
  });

  const page = (pathname: string) => ({
    sveltekit_experimental: {
      state: {
        page: { url: new URL(pathname, "https://dashboard.example.test") },
      },
    },
  });
</script>

<!-- A released build: the version links to the changelog. -->
<Story
  name="Released version"
  parameters={page("/")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }])}
/>

<!-- A dev build: a plain label, no link. -->
<Story
  name="Dev build"
  parameters={page("/")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "dev" } }])}
/>

<!-- The version has not answered: nothing is shown for it. -->
<Story
  name="Version unresolved"
  parameters={page("/")}
  beforeEach={() => mockFetch([{ match: /\/api\/version/, hang: true }])}
/>

<!-- The version request failed: still nothing, no error. -->
<Story
  name="Version request fails"
  parameters={page("/")}
  beforeEach={() => mockFetch([{ match: /\/api\/version/, status: 500 }])}
/>

<!-- On the privacy page its link keeps its place and is marked current. -->
<Story
  name="Privacy page current"
  parameters={page("/privacy")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }])}
/>
