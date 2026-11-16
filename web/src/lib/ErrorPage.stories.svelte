<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, within } from "storybook/test";
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

  // The way out is the same on both pages: home, and the main sections.
  async function expectWaysOut(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: "Back to pull requests" }),
    ).toHaveAttribute("href", "/");
    const next = within(
      canvas.getByRole("navigation", { name: "Where to go next" }),
    );
    for (const [name, href] of [
      ["Issues", "/issues.html"],
      ["Releases", "/releases.html"],
      ["Insights", "/insights.html"],
      ["Settings", "/settings.html"],
    ]) {
      await expect(next.getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    }
  }
</script>

<!-- The address is the problem, so there is no Try again. -->
<Story
  name="Not found"
  args={{ status: 404 }}
  play={async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^Page not found$/,
    );
    await expect(
      canvasElement.querySelector(".error-status"),
    ).toHaveTextContent("404");
    await expectWaysOut(canvasElement);
    await expect(canvas.queryByRole("link", { name: "Try again" })).toBeNull();
  }}
/>

<!-- Trying again reloads the same address, which works with no script. -->
<Story
  name="Server error"
  args={{ status: 500 }}
  play={async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^Something went wrong on our side$/,
    );
    await expect(
      canvasElement.querySelector(".error-status"),
    ).toHaveTextContent("500");
    await expectWaysOut(canvasElement);
    await expect(
      canvas.getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "?");
  }}
/>
