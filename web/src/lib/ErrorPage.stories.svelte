<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import ErrorPage from "./ErrorPage.svelte";

  // ErrorPage embeds Footer, which reads $app/state and /api/version.
  const { Story } = defineMeta({
    title: "ErrorPage",
    component: ErrorPage,
    parameters: {
      sveltekit_experimental: {
        state: {
          page: { url: new URL("/nowhere", "https://dashboard.example.test") },
        },
      },
    },
    beforeEach: () =>
      mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }]),
  });
</script>

<Story name="Not found" args={{ status: 404 }} />
<Story name="Server error" args={{ status: 500 }} />
