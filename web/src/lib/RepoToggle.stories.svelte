<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import axe from "axe-core";
  import { expect, fn } from "storybook/test";
  import RepoToggle from "./RepoToggle.svelte";

  // The icon toggle the Repositories settings draw for Auto-update and Rebase
  // bots (#4028): a fixed name, `aria-pressed` for the state, a 2px outlined
  // square when off, a teal fill with a check badge when on, a spinner while
  // busy. The 40px phone size needs a real viewport; the phone story is its
  // screenshot.
  const { Story } = defineMeta({
    title: "RepoToggle",
    component: RepoToggle,
  });

  function theme(value: "light" | "dark") {
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    root.setAttribute("data-theme", value);
    return () => {
      if (before === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before);
    };
  }

  async function expectToggles(el: HTMLElement) {
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
    await expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      await expect(b.getAttribute("aria-label")).toMatch(/ on acme\/app$/);
      await expect(b.hasAttribute("aria-pressed")).toBe(true);
      const { width, height } = b.getBoundingClientRect();
      await expect(Math.min(width, height)).toBeGreaterThanOrEqual(32);
    }
    const { violations } = await axe.run(el);
    await expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }
</script>

{#snippet toggles()}
  <div style="display: flex; gap: 14px; padding: 12px">
    <RepoToggle
      kind="auto-update"
      name="Auto-update on acme/app"
      pressed={false}
      onclick={fn()}
    />
    <RepoToggle
      kind="auto-update"
      name="Auto-update on acme/app"
      pressed={true}
      onclick={fn()}
    />
    <RepoToggle
      kind="rebase-bots"
      name="Rebase bots on acme/app"
      pressed={false}
      onclick={fn()}
    />
    <RepoToggle
      kind="rebase-bots"
      name="Rebase bots on acme/app"
      pressed={true}
      onclick={fn()}
    />
    <RepoToggle
      kind="rebase-bots"
      name="Rebase bots on acme/app"
      pressed={false}
      busy={true}
      onclick={fn()}
    />
    <RepoToggle
      kind="rebase-bots"
      name="Rebase bots on acme/app"
      pressed={false}
      disabled={true}
      describedby="story-lock"
      onclick={fn()}
    />
    <span id="story-lock" class="sr-only">
      Dependabot needs a personal access token when a GitHub App is connected.
    </span>
  </div>
{/snippet}

<Story
  asChild
  name="All states, light"
  beforeEach={() => theme("light")}
  play={async ({ canvasElement }) => expectToggles(canvasElement)}
>
  {@render toggles()}
</Story>

<Story
  asChild
  name="All states, dark"
  beforeEach={() => theme("dark")}
  play={async ({ canvasElement }) => expectToggles(canvasElement)}
>
  {@render toggles()}
</Story>

<Story
  asChild
  name="Phone width"
  globals={{ viewport: { value: "mobile1" } }}
  play={async ({ canvasElement }) => expectToggles(canvasElement)}
>
  {@render toggles()}
</Story>
