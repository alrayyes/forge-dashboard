<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import axe from "axe-core";
  import { expect, fn } from "storybook/test";
  import type { MainBranchCounts, StatusPill } from "./main-branches.js";
  import StatusPills from "./StatusPills.svelte";

  // The status group of the Main branches filter (#4221): the CI pill's glyph
  // before the word, the glyph tinted until the pill is pressed, then the
  // state's own pair and a ring.
  const { Story } = defineMeta({
    title: "StatusPills",
    component: StatusPills,
  });

  const STATUSES: StatusPill[] = [
    "failed",
    "passed",
    "running",
    "cancelled",
    "awaiting_approval",
    "unknown",
    "none",
  ];
  const EVERY: StatusPill[] = ["all", ...STATUSES];
  const GLYPHS = [
    "cross",
    "check",
    "arc",
    "stop",
    "pause",
    "question",
    "slash",
  ];
  const offered = new Set<StatusPill>(["all", ...STATUSES]);
  const counts: MainBranchCounts = {
    total: 14,
    failed: 3,
    passed: 4,
    running: 2,
    cancelled: 1,
    awaitingApproval: 1,
    unknown: 1,
    none: 2,
  };

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

  // Every row: the glyphs, the pressed ring for the row's status, and axe.
  async function expectEveryState(el: HTMLElement) {
    for (const row of el.querySelectorAll<HTMLElement>("[data-row]")) {
      const pressed = row.dataset.row as string;
      const buttons = pills(row);
      await expect(buttons).toHaveLength(8);
      await expect(
        buttons
          .slice(1)
          .map((b) => b.querySelector("svg")?.getAttribute("data-glyph")),
      ).toEqual(GLYPHS);
      await expect(buttons[0].querySelector("svg")).toBeNull();
      const on = buttons.filter(
        (b) => b.getAttribute("aria-pressed") === "true",
      );
      await expect(on).toHaveLength(pressed === "none-pressed" ? 0 : 1);
      for (const b of on) {
        // A status pill is ringed; All keeps its fill.
        const ring = getComputedStyle(b).boxShadow;
        await expect(ring.includes("inset")).toBe(
          b.dataset.status !== undefined,
        );
      }
    }
    const { violations } = await axe.run(el);
    await expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }
</script>

{#snippet everyState()}
  <div data-row="none-pressed">
    <StatusPills
      {offered}
      {counts}
      status={"none-pressed" as StatusPill}
      onselect={fn()}
    />
  </div>
  {#each EVERY as status (status)}
    <div data-row={status} style="margin-top: 10px">
      <StatusPills {offered} {counts} {status} onselect={fn()} />
    </div>
  {/each}
{/snippet}

<!-- Every status unpressed, then once with each pill pressed. -->
<Story
  asChild
  name="Every status, light"
  beforeEach={() => theme("light")}
  play={async ({ canvasElement }) => expectEveryState(canvasElement)}
>
  {@render everyState()}
</Story>

<Story
  asChild
  name="Every status, dark"
  beforeEach={() => theme("dark")}
  play={async ({ canvasElement }) => expectEveryState(canvasElement)}
>
  {@render everyState()}
</Story>

<!-- Only the statuses some branch has are offered. -->
<Story
  name="Some statuses"
  args={{
    offered: new Set<StatusPill>(["all", "failed", "passed"]),
    counts,
    status: "failed",
    onselect: fn(),
  }}
  play={async ({ canvasElement }) => {
    await expect(pills(canvasElement)).toHaveLength(3);
  }}
/>
