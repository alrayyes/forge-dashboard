<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import axe from "axe-core";
  import { expect, fn } from "storybook/test";
  import FilterGroup from "./FilterGroup.svelte";
  import FilterPill from "./FilterPill.svelte";

  // The one pill every filter group draws (#4279): a labelled group of
  // `aria-pressed` buttons, 32px high with a count, the CI states wearing
  // their glyph. The Main branches and pull request pages and its phone
  // Filters sheet draw these. The 44px phone hit area needs a real viewport,
  // so the e2e spec checks it; the phone story is its screenshot.
  const { Story } = defineMeta({
    title: "FilterPill",
    component: FilterPill,
  });

  // The stylesheet's dark tokens hang on the root's data-theme.
  function theme(value: "light" | "dark") {
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    root.setAttribute("data-theme", value);

    return () => {
      if (before === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before);
    };
  }

  const pills = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLElement>(".filter-pill"),
  ];

  // A space ahead of the text leaks into the button's name and any exact text
  // match on the pill.
  async function expectNoLeadingSpace(b: HTMLElement) {
    await expect(b.textContent).toBe(b.textContent?.trimStart());
  }

  async function expectGroups(el: HTMLElement) {
    const buttons = pills(el);
    await expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) {
      await expect(b.getBoundingClientRect().height).toBe(32);
      await expect(b.querySelector(".filter-pill-count")).not.toBeNull();
      await expectNoLeadingSpace(b);
    }
    for (const group of el.querySelectorAll<HTMLElement>("[role=group]")) {
      const label = group.querySelector(".filter-group-label");
      await expect(label?.textContent?.trim()).not.toBe("");
      await expect(group.getAttribute("aria-labelledby")).toBe(label?.id);
      await expect(
        group.querySelectorAll("[aria-pressed='true']"),
      ).toHaveLength(1);
    }
    const { violations } = await axe.run(el);
    await expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }

  // The behind chip (#4624): the count leads its words, and axe is clean in
  // both states.
  async function expectBehind(el: HTMLElement) {
    const chips = el.querySelectorAll<HTMLElement>("[data-pill=behind-base]");
    await expect(chips).toHaveLength(2);
    for (const chip of chips) {
      await expectNoLeadingSpace(chip);
      await expect(chip.textContent?.replace(/\s+/g, " ").trim()).toBe(
        "3 behind the base branch",
      );
    }
    const { violations } = await axe.run(el);
    await expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }
</script>

{#snippet groups()}
  <div style="display: grid; gap: 10px">
    <FilterGroup label="Forge" id="story-forge">
      <FilterPill pressed={true} count={42} onclick={fn()}>All</FilterPill>
      <FilterPill pressed={false} count={30} onclick={fn()}>GitHub</FilterPill>
      <FilterPill pressed={false} count={12} onclick={fn()}>Forgejo</FilterPill>
    </FilterGroup>
    <FilterGroup label="CI" id="story-ci">
      <FilterPill pressed={false} count={42} onclick={fn()}>All</FilterPill>
      <FilterPill pressed={true} count={28} status="passed" onclick={fn()}>
        Passing
      </FilterPill>
      <FilterPill pressed={false} count={6} status="failed" onclick={fn()}>
        Failing
      </FilterPill>
      <FilterPill pressed={false} count={8} status="running" onclick={fn()}>
        Running
      </FilterPill>
    </FilterGroup>
  </div>
{/snippet}

<Story
  asChild
  name="Forge and CI, light"
  beforeEach={() => theme("light")}
  play={async ({ canvasElement }) => expectGroups(canvasElement)}
>
  {@render groups()}
</Story>

<Story
  asChild
  name="Forge and CI, dark"
  beforeEach={() => theme("dark")}
  play={async ({ canvasElement }) => expectGroups(canvasElement)}
>
  {@render groups()}
</Story>

<!-- Narrow, so the label sits above its pills and the hit area is the phone's. -->
<Story
  asChild
  name="Phone width"
  globals={{ viewport: { value: "mobile1" } }}
  play={async ({ canvasElement }) => {
    await expectGroups(canvasElement);
  }}
>
  {@render groups()}
</Story>

<!-- The behind chip (#4624): the count leads, and the chip turns amber when
     pressed. Its name is its visible text. -->
{#snippet behind()}
  <div style="display: grid; gap: 10px">
    {#each [false, true] as pressed (pressed)}
      <FilterGroup label="Merge" id="story-merge-{pressed}">
        <FilterPill pressed={!pressed} count={12} onclick={fn()}>
          All
        </FilterPill>
        <FilterPill
          data-pill="behind-base"
          {pressed}
          count={3}
          countFirst
          onclick={fn()}
        >
          behind the base branch
        </FilterPill>
      </FilterGroup>
    {/each}
  </div>
{/snippet}

<Story
  asChild
  name="Behind chip, light"
  beforeEach={() => theme("light")}
  play={async ({ canvasElement }) => expectBehind(canvasElement)}
>
  {@render behind()}
</Story>

<Story
  asChild
  name="Behind chip, dark"
  beforeEach={() => theme("dark")}
  play={async ({ canvasElement }) => expectBehind(canvasElement)}
>
  {@render behind()}
</Story>
